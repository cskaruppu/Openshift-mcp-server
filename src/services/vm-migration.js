/**
 * VM Migration — UC-10, on Migration Toolkit for Virtualization (MTV/Forklift).
 *
 *   readiness ──▶ discover ──▶ group into Plans ──▶ Plan (validates) ──▶ CR
 *                                                        │
 *                              approved ──▶ Migration ──▶ progress ──▶ verified
 *                                                        └──▶ ROLLBACK
 *
 * Three rules carried over from UC-06, for the same reasons:
 *
 *  1. The LLM never writes a Plan. It recommends warm vs cold and explains
 *     failures; every manifest is built by fixed logic from a typed struct.
 *  2. Nothing is autonomous. A migration moves production workloads, so it is
 *     human-selected and change-approved by construction.
 *  3. THE SOURCE VM IS NEVER DELETED. Cold migration powers it off; that is the
 *     way back, and it stays until a person raises a decommission request.
 *
 * MTV shape that drives the design: Plan.spec.vms is a LIST, but `warm`, the
 * provider, both maps and the target namespace are PLAN-level. So a selection
 * that mixes strategies or targets becomes several Plans — planGroups() is
 * where that is decided, and it is pure so it can be tested.
 */

import { ocpGet, ocpPost, ocpDelete, ocpFetch } from "../utils/openshift-client.js";
import { recordChange } from "./change-ledger.js";

const FORKLIFT = "apis/forklift.konveyor.io/v1beta1";
const MTV_NS = process.env.MTV_NAMESPACE || "openshift-mtv";

/** Providers whose VMs we can migrate FROM. */
const SOURCE_TYPES = new Set(["vsphere", "ovirt", "openstack", "ova"]);

const nowIso = () => new Date().toISOString();
const cond = (o, type) => (o?.status?.conditions || []).find((c) => c.type === type);
const isTrue = (o, type) => cond(o, type)?.status === "True";

// ---------------------------------------------------------------------------
// 1. Readiness — is MTV actually usable, not merely installed
// ---------------------------------------------------------------------------
/**
 * Everything that must be true before a migration can be planned, checked
 * against the live cluster. Deliberately reports WHY each item failed and what
 * to do, rather than a bare boolean: "MTV not ready" helps nobody.
 *
 * @returns {{ok:boolean, blocking:Array, warnings:Array, operator:object,
 *            providers:Array, storageMaps:Array, networkMaps:Array}}
 */
/**
 * What a failure to read forklift.konveyor.io actually means. Pure, because
 * this exact distinction was got wrong in the field: MTV v2.11.7 was installed
 * and healthy, the agent simply had no RBAC for it, and a 403 was reported as
 * "not installed" — which sends someone to reinstall a working operator.
 *
 * @returns {null|{code:string, message:string, fix?:string, rbacDenied?:boolean}}
 */
export function mtvAccessVerdict({ status = 0, error = null, namespace = MTV_NS } = {}) {
  if (!error) return null;
  if (status === 403) {
    return {
      code: "mtv-rbac-denied",
      rbacDenied: true,
      message: `MTV is installed, but this service account may not read forklift.konveyor.io resources in "${namespace}". Grant the migration role — it is an opt-in ClusterRole, applied cluster-side with no image rebuild.`,
      fix: "oc apply -f https://raw.githubusercontent.com/cskaruppu/openshift-mcp-server/claude/setup-mcp-openshift-9JUo7/deploy/dashboard/manifests/serviceaccount.yaml",
    };
  }
  if (status === 404) {
    return {
      code: "mtv-not-installed",
      message: "The forklift.konveyor.io API is not served by this cluster — the MTV operator is not installed.",
    };
  }
  return {
    code: "mtv-not-installed",
    message: `Could not read MTV in "${namespace}": ${error}. Install the MTV operator, or set MTV_NAMESPACE if it lives elsewhere.`,
  };
}

export async function checkMtvReadiness() {
  const blocking = [], warnings = [];
  // Keep the HTTP status: "we may not look" and "it is not there" are entirely
  // different problems with entirely different fixes, and conflating them sends
  // someone to reinstall an operator that was working all along.
  const safe = async (p) => {
    try { return await ocpGet(p); }
    catch (e) {
      const m = /OCP API (\d{3})/.exec(e.message || "");
      return { __error: e.message, __status: m ? Number(m[1]) : 0 };
    }
  };

  // Operator / controller
  const fc = await safe(`/${FORKLIFT}/namespaces/${MTV_NS}/forkliftcontrollers`);

  const access = mtvAccessVerdict({ status: fc.__status, error: fc.__error, namespace: MTV_NS });
  if (access) {
    blocking.push(access);
    return {
      ok: false, blocking, warnings, rbacDenied: access.rbacDenied,
      operator: { installed: !!access.rbacDenied, readable: false, namespace: MTV_NS },
      providers: [], sources: [], targets: [], storageMaps: [], networkMaps: [], checkedAt: nowIso(),
    };
  }

  const controller = (fc.items || [])[0] || null;
  const operator = {
    installed: !fc.__error && Array.isArray(fc.items),
    readable: !fc.__error,
    namespace: MTV_NS,
    name: controller?.metadata?.name || null,
    ready: controller ? isTrue(controller, "Successful") || isTrue(controller, "Ready") : false,
  };
  if (!controller) {
    blocking.push({ code: "no-forklift-controller", message: `No ForkliftController in ${MTV_NS} — the operator is installed but not configured.` });
  } else if (!operator.ready) {
    warnings.push({ code: "controller-not-ready", message: `ForkliftController "${operator.name}" is not reporting Ready yet.` });
  }

  // Providers
  const provList = await safe(`/${FORKLIFT}/namespaces/${MTV_NS}/providers`);
  const providers = (provList.items || []).map((p) => ({
    name: p.metadata.name,
    namespace: p.metadata.namespace,
    uid: p.metadata.uid,
    type: (p.spec?.type || "").toLowerCase(),
    url: p.spec?.url || null,
    isSource: SOURCE_TYPES.has((p.spec?.type || "").toLowerCase()),
    ready: isTrue(p, "Ready"),
    connected: isTrue(p, "ConnectionTested") || isTrue(p, "Ready"),
    reason: cond(p, "Ready")?.message || cond(p, "ConnectionTested")?.message || null,
  }));
  const sources = providers.filter((p) => p.isSource);
  const targets = providers.filter((p) => p.type === "openshift");

  if (sources.length === 0) {
    blocking.push({ code: "no-source-provider", message: "No source provider configured (vSphere, oVirt, OpenStack or OVA). Add one in MTV before migrating." });
  }
  if (targets.length === 0) {
    // MTV creates a "host" provider for the local cluster; its absence is unusual.
    blocking.push({ code: "no-target-provider", message: "No OpenShift target provider configured in MTV." });
  }
  for (const p of providers) {
    if (!p.connected) {
      blocking.push({ code: "provider-not-connected", message: `Provider "${p.name}" (${p.type}) is not connected${p.reason ? ` — ${p.reason}` : ""}. Check its URL and credentials secret.` });
    }
  }

  // Maps
  const [smList, nmList] = await Promise.all([
    safe(`/${FORKLIFT}/namespaces/${MTV_NS}/storagemaps`),
    safe(`/${FORKLIFT}/namespaces/${MTV_NS}/networkmaps`),
  ]);
  const mapOf = (list) => (list.items || []).map((m) => ({
    name: m.metadata.name,
    namespace: m.metadata.namespace,
    ready: isTrue(m, "Ready"),
    reason: cond(m, "Ready")?.message || null,
    sourceProvider: m.spec?.provider?.source?.name || null,
    targetProvider: m.spec?.provider?.destination?.name || null,
    entries: (m.spec?.map || []).length,
    // Source identifiers this map covers — used to prove a selection is mappable.
    covers: (m.spec?.map || []).map((e) => e.source?.id || e.source?.name || e.source?.type).filter(Boolean),
  }));
  const storageMaps = mapOf(smList), networkMaps = mapOf(nmList);

  if (storageMaps.length === 0) blocking.push({ code: "no-storage-map", message: "No StorageMap exists. Create one mapping each source datastore to a target storage class." });
  if (networkMaps.length === 0) blocking.push({ code: "no-network-map", message: "No NetworkMap exists. Create one mapping each source network to a target network." });
  for (const m of [...storageMaps, ...networkMaps]) {
    if (!m.ready) warnings.push({ code: "map-not-ready", message: `Map "${m.name}" is not Ready${m.reason ? ` — ${m.reason}` : ""}.` });
  }

  return {
    ok: blocking.length === 0,
    blocking, warnings, operator,
    providers, sources, targets, storageMaps, networkMaps,
    checkedAt: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// 2. Discovery — VMs live in MTV's inventory service, not in Kubernetes
// ---------------------------------------------------------------------------
/**
 * MTV mirrors each provider's inventory into a service in its own namespace;
 * the VMs are NOT Kubernetes objects. Reached by ClusterIP read from the API
 * server, so no in-cluster DNS is required — the same approach the Prometheus
 * client uses, and for the same reason.
 */
async function inventoryBase() {
  const svc = await ocpGet(`/api/v1/namespaces/${MTV_NS}/services/forklift-inventory`).catch(() => null);
  if (!svc) throw new Error(`No "forklift-inventory" service in ${MTV_NS} — cannot list VMs.`);
  const ip = svc.spec?.clusterIP;
  const port = (svc.spec?.ports || []).find((p) => /https|api|8443/.test(`${p.name}${p.port}`))?.port
    || svc.spec?.ports?.[0]?.port || 8443;
  if (!ip || ip === "None") throw new Error("The forklift-inventory service has no ClusterIP.");
  return `https://${ip}:${port}`;
}

async function inventoryGet(path) {
  const { fetch: undiciFetch, Agent } = await import("undici");
  const { readFile } = await import("node:fs/promises");
  const base = await inventoryBase();
  let token = "";
  try { token = (await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim(); } catch { /* dev */ }
  // The inventory service presents a service-serving certificate. Verifying it
  // needs the service-ca bundle, which is not always mounted; reachability of a
  // service inside our own cluster is what matters here, not its identity.
  const agent = new Agent({ connect: { rejectUnauthorized: false, timeout: 8000 } });
  const r = await undiciFetch(`${base}${path}`, {
    dispatcher: agent,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Inventory ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return r.json();
}

/**
 * VMs discovered on a source provider, with the facts a migration decision
 * actually turns on: power state, disk footprint, and whether changed-block
 * tracking makes a warm migration possible at all.
 */
export async function discoverVMs(providerUid, { search = "" } = {}) {
  const raw = await inventoryGet(`/providers/vsphere/${providerUid}/vms?detail=1`)
    .catch(async () => inventoryGet(`/providers/${providerUid}/vms?detail=1`));
  const list = Array.isArray(raw) ? raw : (raw?.items || []);
  const vms = list.map((v) => normaliseInventoryVM(v));
  const q = search.trim().toLowerCase();
  return q ? vms.filter((v) => v.name.toLowerCase().includes(q)) : vms;
}

/** One shape regardless of provider flavour, so the card never branches. */
export function normaliseInventoryVM(v = {}) {
  const disks = v.disks || v.Disks || [];
  const totalBytes = disks.reduce((n, d) => n + (d.capacity || d.Capacity || 0), 0);
  const cbt = v.changeTrackingEnabled ?? v.changeTrackingSupported ?? null;
  const powered = /poweredOn|up|ACTIVE|running/i.test(String(v.powerState || v.status || ""));
  return {
    id: v.id || v.uuid || v.ID || null,
    name: v.name || v.Name || "(unnamed)",
    path: v.path || null,
    powerState: v.powerState || v.status || "unknown",
    poweredOn: powered,
    cpuCount: v.cpuCount ?? v.cpuCores ?? null,
    memoryMB: v.memoryMB ?? (v.memory ? Math.round(v.memory / 1048576) : null),
    guestOS: v.guestName || v.guestId || v.osType || null,
    diskCount: disks.length,
    diskBytes: totalBytes,
    diskGiB: totalBytes ? Math.round(totalBytes / 1073741824) : null,
    // The single fact that decides whether warm is even offered.
    changeTrackingEnabled: cbt === true,
    warmEligible: cbt === true && powered,
    warmBlockedReason: cbt === true
      ? (powered ? null : "The VM is powered off — warm migration has nothing to track. Use cold.")
      : "Changed block tracking is not enabled on this VM, so an incremental copy is impossible. Use cold, or enable CBT and rediscover.",
    datastores: [...new Set(disks.map((d) => d.datastore?.id || d.datastore?.name || d.Datastore).filter(Boolean))],
    networks: (v.networks || v.Networks || []).map((n) => n.id || n.name || n).filter(Boolean),
    concerns: (v.concerns || []).map((c) => ({ label: c.label || c.category, assessment: c.assessment })),
  };
}

// ---------------------------------------------------------------------------
// 3. Grouping — MTV forces this, so make it explicit rather than surprising
// ---------------------------------------------------------------------------
/**
 * Split a selection into the Plans MTV will actually accept.
 *
 * `warm`, the provider, both maps and the target namespace are PLAN-level in
 * Forklift, so any difference forces another Plan. Pure, and tested: getting
 * this wrong means a Plan the API server rejects, or worse, a silent mix.
 *
 * @param {Array} selection  [{ vm, strategy:"warm"|"cold", storageMap, networkMap, targetNamespace, sourceProvider }]
 * @returns {{groups:Array, errors:Array}}
 */
export function planGroups(selection = []) {
  const errors = [];
  const byKey = new Map();

  for (const s of selection) {
    const vm = s.vm || {};
    if (!vm.id && !vm.name) { errors.push({ message: "A selected VM has neither id nor name." }); continue; }
    const strategy = s.strategy === "warm" ? "warm" : "cold";
    if (strategy === "warm" && vm.warmEligible === false) {
      errors.push({ vm: vm.name, message: `${vm.name} cannot be migrated warm — ${vm.warmBlockedReason || "not eligible"}.` });
      continue;
    }
    // A VM missing any plan-level field is excluded, not grouped with a hole
    // in it — otherwise planGroups returns a group that builds an invalid
    // manifest, and the caller has to remember to check errors first.
    let incomplete = false;
    for (const [field, val] of Object.entries({
      sourceProvider: s.sourceProvider, storageMap: s.storageMap,
      networkMap: s.networkMap, targetNamespace: s.targetNamespace,
    })) {
      if (!val) { errors.push({ vm: vm.name, message: `${vm.name}: ${field} is not set.` }); incomplete = true; }
    }
    if (incomplete) continue;

    const key = [s.sourceProvider, strategy, s.storageMap, s.networkMap, s.targetNamespace].join("|");
    if (!byKey.has(key)) {
      byKey.set(key, {
        key, strategy, warm: strategy === "warm",
        sourceProvider: s.sourceProvider, storageMap: s.storageMap,
        networkMap: s.networkMap, targetNamespace: s.targetNamespace,
        vms: [],
      });
    }
    byKey.get(key).vms.push({ id: vm.id || null, name: vm.name });
  }

  const groups = [...byKey.values()].map((g, i) => ({
    ...g,
    planName: planNameFor(g, i),
    totalVMs: g.vms.length,
  }));
  return { groups, errors };
}

/** Deterministic, DNS-safe Plan name — the same selection always names alike. */
export function planNameFor(group, index = 0) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const base = `mig-${group.strategy}-${group.targetNamespace}-${stamp}`;
  const safe = base.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 48).replace(/^-+|-+$/g, "");
  return index > 0 ? `${safe}-${index + 1}` : safe;
}

// ---------------------------------------------------------------------------
// 4. Manifests
// ---------------------------------------------------------------------------
export function buildPlanManifest(group, { targetProvider }) {
  return {
    apiVersion: "forklift.konveyor.io/v1beta1",
    kind: "Plan",
    metadata: {
      name: group.planName,
      namespace: MTV_NS,
      labels: {
        "app.kubernetes.io/managed-by": "tcs-agentic-ai",
        "tcs.agentic-ai/strategy": group.strategy,
      },
    },
    spec: {
      provider: {
        source: { name: group.sourceProvider, namespace: MTV_NS },
        destination: { name: targetProvider, namespace: MTV_NS },
      },
      map: {
        network: { name: group.networkMap, namespace: MTV_NS },
        storage: { name: group.storageMap, namespace: MTV_NS },
      },
      targetNamespace: group.targetNamespace,
      // Plan-level, not per VM. This is why the selection was grouped.
      warm: group.warm === true,
      vms: group.vms.map((v) => (v.id ? { id: v.id, name: v.name } : { name: v.name })),
    },
  };
}

export function buildMigrationManifest(planName, { cutover = null } = {}) {
  return {
    apiVersion: "forklift.konveyor.io/v1beta1",
    kind: "Migration",
    metadata: {
      name: `${planName}-${Date.now().toString(36)}`,
      namespace: MTV_NS,
      labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai" },
    },
    spec: {
      plan: { name: planName, namespace: MTV_NS },
      // Warm migrations copy continuously and cut over at this moment. Absent
      // means "cut over as soon as the operator asks".
      ...(cutover ? { cutover } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Create / execute
// ---------------------------------------------------------------------------
/** Create the Plans. Creating a Plan moves nothing — MTV validates it first. */
export async function createPlans(groups, { targetProvider, actor = "operator", cluster = "local" } = {}) {
  const created = [], failed = [], terminal = [];
  for (const g of groups) {
    const manifest = buildPlanManifest(g, { targetProvider });
    terminal.push(`$ oc apply -f plan-${g.planName}.yaml -n ${MTV_NS}`);
    try {
      const r = await ocpPost(`/${FORKLIFT}/namespaces/${MTV_NS}/plans`, manifest);
      created.push({ planName: g.planName, uid: r.metadata?.uid || null, strategy: g.strategy, vms: g.vms.length });
      terminal.push(`plan.forklift.konveyor.io/${g.planName} created (${g.vms.length} VM${g.vms.length === 1 ? "" : "s"}, ${g.strategy})`);
      await recordChange({
        cluster, namespace: MTV_NS, resourceKind: "plan", resourceName: g.planName,
        action: "create_migration_plan", command: `oc apply -f plan-${g.planName}.yaml -n ${MTV_NS}`,
        risk: "low", approvedBy: actor,
        // A Plan alone moves nothing, so its inverse is simply removing it.
        revertCommand: `oc delete plan ${g.planName} -n ${MTV_NS}`,
      }).catch(() => {});
    } catch (e) {
      failed.push({ planName: g.planName, error: e.message });
      terminal.push(`Error: ${e.message}`);
    }
  }
  return { ok: failed.length === 0, created, failed, terminal };
}

/** Plan validation verdict — the dry-run equivalent. Creating it moved nothing. */
export async function planStatus(planName) {
  const p = await ocpGet(`/${FORKLIFT}/namespaces/${MTV_NS}/plans/${planName}`).catch(() => null);
  if (!p) return { found: false, planName };
  const c = (t) => cond(p, t);
  return {
    found: true, planName,
    ready: isTrue(p, "Ready"),
    executing: isTrue(p, "Executing"),
    succeeded: isTrue(p, "Succeeded"),
    failed: isTrue(p, "Failed"),
    canceled: isTrue(p, "Canceled"),
    warm: p.spec?.warm === true,
    targetNamespace: p.spec?.targetNamespace || null,
    vmCount: (p.spec?.vms || []).length,
    // Anything MTV objects to — unmapped datastore, missing network, no CBT.
    critical: (p.status?.conditions || [])
      .filter((x) => x.category === "Critical" || (x.type === "Ready" && x.status === "False"))
      .map((x) => `${x.type}${x.reason ? `/${x.reason}` : ""}: ${x.message || ""}`.trim()),
    vms: (p.status?.migration?.vms || []).map(normalisePlanVM),
  };
}

function normalisePlanVM(v) {
  const pipeline = (v.pipeline || []).map((s) => ({
    name: s.name, phase: s.phase,
    progress: s.progress ? { completed: s.progress.completed, total: s.progress.total } : null,
  }));
  const done = pipeline.filter((s) => s.phase === "Completed").length;
  const err = (v.error?.reasons || []).join("; ") || v.error?.phase || null;
  return {
    id: v.id || null, name: v.name,
    phase: v.phase || "Pending",
    started: v.started || null, completed: v.completed || null,
    steps: pipeline, stepsDone: done, stepsTotal: pipeline.length,
    percent: pipeline.length ? Math.round((done / pipeline.length) * 100) : 0,
    error: err,
    failed: !!err || /Failed|Canceled/i.test(v.phase || ""),
  };
}

/** Execute an approved Plan. This is the point where data starts moving. */
export async function startMigration(planName, { cutover = null, actor = "operator", cluster = "local" } = {}) {
  const st = await planStatus(planName);
  if (!st.found) return { ok: false, error: `Plan "${planName}" not found.` };
  if (!st.ready) return { ok: false, error: `Plan "${planName}" is not Ready — MTV has not validated it.`, critical: st.critical };

  const manifest = buildMigrationManifest(planName, { cutover });
  try {
    const r = await ocpPost(`/${FORKLIFT}/namespaces/${MTV_NS}/migrations`, manifest);
    await recordChange({
      cluster, namespace: MTV_NS, resourceKind: "migration", resourceName: manifest.metadata.name,
      action: "start_vm_migration", command: `oc apply -f migration-${planName}.yaml -n ${MTV_NS}`,
      risk: "high", approvedBy: actor,
      revertCommand: `# cancel: oc delete migration ${manifest.metadata.name} -n ${MTV_NS}; then delete migrated VMs and power the source back on`,
    }).catch(() => {});
    return { ok: true, migrationName: manifest.metadata.name, planName, uid: r.metadata?.uid || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// 6. Rollback — the way back, at every stage
// ---------------------------------------------------------------------------
/**
 * What rolling back MEANS depends on how far the migration got, and pretending
 * otherwise is how people lose data. Pure, so the decision can be tested.
 *
 * The invariant that makes any of this safe: MTV powers the source VM off for a
 * cold migration, it does not delete it. This platform never deletes a source
 * VM either. Rollback is therefore always possible — the cost is only how much
 * transferred work is discarded.
 *
 * @returns {{stage:string, reversible:boolean, actions:Array, sourceAction:string|null, warning:string|null}}
 */
export function rollbackPlan(status) {
  const anyStarted = (status?.vms || []).some((v) => v.started);
  const anyCompleted = (status?.vms || []).some((v) => /Completed|Succeeded/i.test(v.phase || ""));

  if (!status?.found) {
    return { stage: "unknown", reversible: false, actions: [], sourceAction: null, warning: "Plan not found — nothing to roll back." };
  }
  if (status.succeeded || anyCompleted) {
    return {
      stage: "migrated",
      reversible: true,
      actions: [
        "Delete the VirtualMachines this plan created in the target namespace",
        "Archive the plan so it cannot be re-run by accident",
      ],
      sourceAction: "Power the source VM(s) back on in the source platform. MTV powered them off for cutover; it did not delete them.",
      warning: "The migrated disks are discarded. Any data written INSIDE the migrated VM since cutover is lost — confirm nobody has started using it.",
    };
  }
  if (status.executing || anyStarted) {
    return {
      stage: status.warm ? "transferring-warm" : "transferring-cold",
      reversible: true,
      actions: [
        "Cancel the running migration",
        "Delete any partially created target VMs and their disks",
      ],
      sourceAction: status.warm
        ? "None — a warm migration has not cut over, so the source VM is still running and serving."
        : "Power the source VM(s) back on. A cold migration powered them off at the start.",
      warning: "Transferred data is discarded; a restarted migration copies from the beginning.",
    };
  }
  return {
    stage: "planned",
    reversible: true,
    actions: ["Delete the plan"],
    sourceAction: null,
    warning: null,
  };
}

/**
 * Execute the rollback. Deletes ONLY what this plan created — target VMs whose
 * provenance says they came from this plan — and never touches the source.
 */
export async function rollbackMigration(planName, { deleteTargetVMs = true, actor = "operator", cluster = "local" } = {}) {
  const status = await planStatus(planName);
  const decision = rollbackPlan(status);
  if (!status.found) return { ok: false, error: `Plan "${planName}" not found.`, decision };

  const terminal = [], deleted = [], failed = [];

  // 1. Stop anything in flight.
  const migs = await ocpGet(`/${FORKLIFT}/namespaces/${MTV_NS}/migrations`).catch(() => ({ items: [] }));
  for (const m of (migs.items || []).filter((x) => x.spec?.plan?.name === planName)) {
    terminal.push(`$ oc delete migration ${m.metadata.name} -n ${MTV_NS}`);
    try { await ocpDelete(`/${FORKLIFT}/namespaces/${MTV_NS}/migrations/${m.metadata.name}`); deleted.push(`migration/${m.metadata.name}`); }
    catch (e) { failed.push({ target: `migration/${m.metadata.name}`, error: e.message }); }
  }

  // 2. Remove the VMs this plan produced, in the target namespace only.
  if (deleteTargetVMs && status.targetNamespace) {
    for (const v of status.vms || []) {
      if (!v.name) continue;
      terminal.push(`$ oc delete vm ${v.name} -n ${status.targetNamespace}`);
      try {
        await ocpDelete(`/apis/kubevirt.io/v1/namespaces/${status.targetNamespace}/virtualmachines/${v.name}`);
        deleted.push(`virtualmachine/${v.name}`);
      } catch (e) {
        if (/404|NotFound/i.test(e.message)) terminal.push(`# ${v.name} was not created — nothing to remove`);
        else failed.push({ target: `virtualmachine/${v.name}`, error: e.message });
      }
    }
  }

  // 3. Retire the plan so it cannot be re-run by accident.
  terminal.push(`$ oc delete plan ${planName} -n ${MTV_NS}`);
  try { await ocpDelete(`/${FORKLIFT}/namespaces/${MTV_NS}/plans/${planName}`); deleted.push(`plan/${planName}`); }
  catch (e) { failed.push({ target: `plan/${planName}`, error: e.message }); }

  await recordChange({
    cluster, namespace: MTV_NS, resourceKind: "plan", resourceName: planName,
    action: "rollback_vm_migration", command: `rollback ${planName}`,
    risk: "high", approvedBy: actor,
  }).catch(() => {});

  return {
    ok: failed.length === 0,
    planName, decision, deleted, failed, terminal,
    // Said last because it is the part the platform cannot do for you.
    sourceAction: decision.sourceAction,
    message: decision.sourceAction
      ? `Rolled back. ONE MANUAL STEP REMAINS: ${decision.sourceAction}`
      : "Rolled back. The source VMs were never touched.",
  };
}

// ---------------------------------------------------------------------------
// 7. Post-migration verification
// ---------------------------------------------------------------------------
/**
 * Migrated is not running. Reuses the VM phase classifier so a migrated machine
 * is judged by exactly the same rules as a provisioned one.
 */
export async function verifyMigration(planName) {
  const status = await planStatus(planName);
  if (!status.found) return { ok: false, error: `Plan "${planName}" not found.` };
  const { vmRuntimeStatus } = await import("./vm-provisioning.js");
  const names = (status.vms || []).map((v) => v.name).filter(Boolean);
  if (!names.length || !status.targetNamespace) {
    return { ok: false, planName, error: "No migrated VMs to verify yet." };
  }
  const runtime = await vmRuntimeStatus(status.targetNamespace, names);
  return {
    ok: runtime.allRunning,
    planName, namespace: status.targetNamespace,
    ...runtime,
    note: runtime.allRunning
      ? "Every migrated VM is running. The source VMs are still powered off — raise a decommission request when you are satisfied."
      : "Not every migrated VM is running yet.",
  };
}
