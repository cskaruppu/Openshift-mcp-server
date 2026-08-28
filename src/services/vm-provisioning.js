/**
 * VM Provisioning — UC-06 Phase 2.
 *
 * Turns a sentence into a governed VM request:
 *
 *   text ──▶ extractVMRequest ──▶ reconcileSizing ──▶ preflight ──▶ dryRun ──▶ provision
 *            (LLM, fenced)        (golden template)   (live cluster)  (API)     (+ledger +CR)
 *
 * Two deliberate design rules:
 *
 *  1. The LLM extracts *intent only*. It never chooses the manifest, the image,
 *     or the command. Everything it produces is a value in a typed struct that
 *     the operator sees and can correct before anything is created. Same
 *     separation as UC-05: the AI explains, fixed logic acts.
 *
 *  2. Nothing here is autonomous. Provisioning consumes quota, addresses,
 *     licences and money, so it is human-initiated and human-approved by
 *     construction — there is no auto-promote path, unlike incident handling.
 */

import { ocpGet, ocpPost } from "../utils/openshift-client.js";
import { classifyJSON, llmEnabled } from "./llm.js";
import { fenceUntrusted, UNTRUSTED_GUARD } from "./untrusted.js";
import { recordChange } from "./change-ledger.js";

const KUBEVIRT_API = "apis/kubevirt.io/v1";
const CDI_API = "apis/cdi.kubevirt.io/v1beta1";
const INSTANCETYPE_API = "apis/instancetype.kubevirt.io/v1beta1";
const DEFAULT_IMAGE_NS = process.env.VM_IMAGE_NAMESPACE || "openshift-virtualization-os-images";

const nowIso = () => new Date().toISOString();

/** Namespaces a VM may never be provisioned into. */
const PROTECTED_NS = [/^kube-/, /^openshift-/, /^default$/, /^openshift$/];

// ---------------------------------------------------------------------------
// The request struct
// ---------------------------------------------------------------------------
/**
 * Normalise a partial request into the full shape, so every downstream stage
 * and the console card can rely on the same keys existing.
 */
export function normalizeVMRequest(p = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    name: (p.name || "").toString().trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "",
    namespace: (p.namespace || "").toString().trim(),
    // Operator opted in to having provisioning create the namespace. Never
    // inferred — creating a namespace is a side effect worth stating.
    createNamespace: p.createNamespace === true,
    count: Math.min(num(p.count, 1), 10),

    os: p.os || null,                       // free text from the user, e.g. "RHEL 9"
    sourceDataSource: p.sourceDataSource || null,
    sourceDataSourceNamespace: p.sourceDataSourceNamespace || DEFAULT_IMAGE_NS,
    sourceRegistryUrl: p.sourceRegistryUrl || null,
    sourceHttpUrl: p.sourceHttpUrl || null,

    cpuCores: num(p.cpuCores, null),
    memoryMi: num(p.memoryMi, null),
    instanceType: p.instanceType || null,
    preference: p.preference || null,

    diskSizeGi: num(p.diskSizeGi, 30),
    storageClass: p.storageClass || null,

    networkAttachmentDefinition: p.networkAttachmentDefinition || null,
    sshKey: p.sshKey || null,
    username: p.username || "cloud-user",
    hostname: p.hostname || null,

    runStrategy: p.runStrategy || "Always",

    owner: p.owner || null,
    costCentre: p.costCentre || null,
    environment: p.environment || null,
    requestId: p.requestId || null,
    expiresOn: p.expiresOn || null,
    sizingRationale: p.sizingRationale || null,
  };
}

/** Fields without which we will not build a manifest. */
export function missingFields(req) {
  const missing = [];
  if (!req.name) missing.push("name");
  if (!req.namespace) missing.push("namespace");
  if (!req.sourceDataSource && !req.sourceRegistryUrl && !req.sourceHttpUrl) missing.push("sourceDataSource");
  if (!req.sshKey) missing.push("sshKey");
  if (!req.instanceType && !(req.cpuCores && req.memoryMi)) missing.push("sizing");
  return missing;
}

// ---------------------------------------------------------------------------
// 1. Intent extraction
// ---------------------------------------------------------------------------
const MEM_RE = /(\d+(?:\.\d+)?)\s*(gb|gib|g|mb|mib|m)\b/gi;

/** Deterministic fallback so extraction still works with the LLM disabled. */
function heuristicExtract(text) {
  const t = String(text || "");
  const out = {};
  // Namespace, most specific form first. Order matters: a bare "in X" would
  // otherwise capture "namespace" or an article.
  const ARTICLES = /^(the|a|an|my|our|your|this|that)$/i;
  const ns = /\b(?:in|into|on)\s+(?:the\s+)?(?:namespace|ns|project)\s+([a-z0-9][a-z0-9-]*)/i.exec(t)
    || /\b(?:namespace|ns|project)\s+([a-z0-9][a-z0-9-]*)/i.exec(t)
    // "in the apps namespace" — the noun precedes the keyword
    || /\b(?:in|into|on)\s+(?:the\s+)?([a-z0-9][a-z0-9-]*)\s+(?:namespace|project)\b/i.exec(t)
    || /\bin\s+(?:the\s+)?([a-z0-9][a-z0-9-]*)\b/i.exec(t);
  if (ns && !ARTICLES.test(ns[1])) out.namespace = ns[1].toLowerCase();
  const nm = /\b(?:call(?:ed)?|named?)\s+([a-z0-9][a-z0-9-]*)/i.exec(t);
  if (nm) out.name = nm[1];
  const cpu = /(\d+)\s*(?:v?cpu|core|vcpus|cores)\b/i.exec(t);
  if (cpu) out.cpuCores = Number(cpu[1]);

  // Count. Word-numbers first, because a bare digit before "VMs" is usually an
  // OS version — "RHEL 9 VMs" means version 9, not nine machines.
  const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const wordCnt = /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:[\w.-]+\s+){0,3}?(?:vms?|virtual\s*machines?|instances?)\b/i.exec(t);
  if (wordCnt) out.count = WORDNUM[wordCnt[1].toLowerCase()];
  else {
    const OS_RE = /\b(rhel|centos|fedora|ubuntu|windows|rocky|alma|debian|suse|sles)\s*$/i;
    for (const m of t.matchAll(/\b(\d+)\s+(?:[\w.-]+\s+){0,2}?(?:vms?|virtual\s*machines?|instances?)\b/gi)) {
      // Reject a digit that is an OS version rather than a quantity.
      if (OS_RE.test(t.slice(Math.max(0, m.index - 12), m.index))) continue;
      out.count = Number(m[1]);
      break;
    }
  }
  const disk = /(\d+)\s*(?:gb|gib|g)\s*(?:of\s*)?(?:disk|storage|persistent)/i.exec(t);
  if (disk) out.diskSizeGi = Number(disk[1]);
  // Memory: the largest GB figure that is not the disk figure.
  const mems = [...t.matchAll(MEM_RE)].map((m) => {
    const v = Number(m[1]);
    return /^m/i.test(m[2]) ? v : v * 1024;
  });
  const diskMi = out.diskSizeGi ? out.diskSizeGi * 1024 : null;
  const mem = mems.filter((v) => v !== diskMi).sort((a, b) => a - b)[0];
  if (mem) out.memoryMi = mem;
  const os = /\b(rhel\s*\d+|centos\s*\w*|fedora|ubuntu|windows\s*(?:server\s*)?\d*)\b/i.exec(t);
  if (os) out.os = os[1].replace(/\s+/g, " ").trim();
  const vlan = /\bvlan\s*(\d+)\b/i.exec(t);
  if (vlan) out.networkAttachmentDefinition = `vlan${vlan[1]}`;
  // Environment must be a standalone word. Without the hyphen guards, a VM
  // named "test-box" or "prod-api" would set the environment from its own name.
  const env = /(?<![\w-])(prod(?:uction)?|dev(?:elopment)?|test|staging|uat)(?![\w-])/i.exec(t);
  if (env) out.environment = /^prod/i.test(env[1]) ? "prod" : /^dev/i.test(env[1]) ? "dev" : env[1].toLowerCase();
  const cc = /\b(?:cost\s*(?:centre|center)|chargeback|billing\s*code)\s*[:#]?\s*([A-Za-z0-9][\w-]*)/i.exec(t);
  if (cc) out.costCentre = cc[1];
  const ownr = /\b(?:owner|owned\s+by|for\s+the|requested\s+by)\s+([A-Za-z][\w -]{1,40}?)(?:\s+team)?\s*(?:[,.]|$)/i.exec(t);
  if (ownr) out.owner = ownr[1].trim();
  const exp = /\b(?:expir\w*|decommission|until|valid\s+(?:un)?till?)\s*(?:on|by|:)?\s*(\d{4}-\d{2}-\d{2})/i.exec(t);
  if (exp) out.expiresOn = exp[1];
  const key = /\b(ssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+/=]+(?:\s+\S+)?)/.exec(t);
  if (key) out.sshKey = key[1].trim();
  return out;
}

const EXTRACT_SYSTEM = `You extract VM provisioning intent into JSON. You never invent values.
Output ONLY a JSON object with any of these keys you can determine with confidence:
name, namespace, count, os, cpuCores (number), memoryMi (number, MiB),
diskSizeGi (number), storageClass, networkAttachmentDefinition, sshKey, username,
hostname, environment (dev|test|prod), owner, costCentre, requestId, expiresOn (ISO date),
sizingRationale.
Rules:
- Omit any key you are not confident about. Omission is always better than a guess.
- Memory and disk are different things. "32GB RAM, 200GB disk" -> memoryMi 32768, diskSizeGi 200.
- Never output a name or namespace that the text does not contain.
- Never output an sshKey unless the text literally contains a public key.
${UNTRUSTED_GUARD}`;

/**
 * Extract a VM request from free text. LLM-assisted, with a deterministic
 * fallback, and the heuristic always wins for the SSH key (an LLM must never
 * synthesise a credential).
 */
export async function extractVMRequest(text) {
  const heur = heuristicExtract(text);
  let ai = {};
  if (llmEnabled()) {
    try {
      const r = await classifyJSON({
        system: EXTRACT_SYSTEM,
        prompt: `Extract the VM request:\n\n${fenceUntrusted(String(text || "").slice(0, 4000))}`,
      });
      if (r && typeof r === "object") ai = r;
    } catch { /* fall back to heuristics */ }
  }
  const merged = { ...ai, ...heur };          // heuristics win on conflict
  if (heur.sshKey) merged.sshKey = heur.sshKey;
  else if (ai.sshKey && !/^ssh-(rsa|ed25519|dss)\s/.test(String(ai.sshKey))) delete merged.sshKey;

  const req = normalizeVMRequest(merged);
  return {
    request: req,
    missing: missingFields(req),
    // Which fields the user ACTUALLY supplied, as opposed to defaults applied
    // by normalisation. Reporting "I understood: 30Gi disk" when nobody said
    // 30Gi is a small lie that costs trust.
    provided: Object.keys(merged).filter((k) => merged[k] != null && merged[k] !== ""),
    source: llmEnabled() ? "llm+heuristic" : "heuristic",
  };
}

// ---------------------------------------------------------------------------
// 2. What this cluster can actually provision
// ---------------------------------------------------------------------------
export async function listProvisionables(imageNamespace = DEFAULT_IMAGE_NS) {
  const out = { images: [], instanceTypes: [], preferences: [], storageClasses: [], namespaces: [], notes: [] };
  // Namespaces a VM may legitimately live in. Offering these as a list is the
  // difference between typing a name from memory and picking a real one —
  // and platform namespaces are filtered out here rather than rejected later.
  try {
    const ns = await ocpGet(`/api/v1/namespaces`);
    out.namespaces = (ns.items || [])
      .map((n) => n.metadata?.name)
      .filter((n) => n && !PROTECTED_NS.some((re) => re.test(n)))
      .sort();
  } catch { out.notes.push("Could not list namespaces."); }
  try {
    const ds = await ocpGet(`/${CDI_API}/namespaces/${imageNamespace}/datasources`);
    out.images = (ds.items || []).map((d) => ({
      name: d.metadata.name,
      namespace: d.metadata.namespace,
      ready: (d.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True"),
    }));
  } catch { out.notes.push(`No DataSources readable in ${imageNamespace}.`); }
  try {
    const it = await ocpGet(`/${INSTANCETYPE_API}/virtualmachineclusterinstancetypes`);
    out.instanceTypes = (it.items || [])
      .map((i) => ({ name: i.metadata.name, cpu: i.spec?.cpu?.guest ?? null, memory: i.spec?.memory?.guest ?? null }))
      .filter((i) => i.cpu != null)
      .sort((a, b) => a.cpu - b.cpu || parseMemToMi(a.memory) - parseMemToMi(b.memory));
  } catch { out.notes.push("No cluster instance types found."); }
  try {
    const pr = await ocpGet(`/${INSTANCETYPE_API}/virtualmachineclusterpreferences`);
    out.preferences = (pr.items || []).map((p) => p.metadata.name).sort();
  } catch { /* optional */ }
  try {
    const sc = await ocpGet(`/apis/storage.k8s.io/v1/storageclasses`);
    out.storageClasses = (sc.items || []).map((s) => ({
      name: s.metadata.name,
      default: s.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true",
    }));
  } catch { /* optional */ }
  return out;
}

export function parseMemToMi(q) {
  if (!q) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(String(q).trim());
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const mult = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024, K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 };
  return Math.round(v * (mult[m[2]] ?? 1));
}

// ---------------------------------------------------------------------------
// 3. Sizing reconciliation — the differentiator
// ---------------------------------------------------------------------------
/**
 * Map what was asked for onto the nearest golden instance type, and say
 * plainly what the compromise is. Platform teams argue about exactly this, and
 * making the delta visible is the thing a form cannot do.
 */
export function reconcileSizing(req, instanceTypes = []) {
  if (req.instanceType) {
    const it = instanceTypes.find((i) => i.name === req.instanceType);
    return it
      ? { chosen: it, verdict: "explicit", message: `Using the requested instance type ${it.name} (${it.cpu} vCPU / ${it.memory}).` }
      : { chosen: null, verdict: "unknown", message: `Instance type "${req.instanceType}" was not found on this cluster.` };
  }
  if (!req.cpuCores || !req.memoryMi) return { chosen: null, verdict: "insufficient", message: "Not enough sizing information to reconcile." };
  if (!instanceTypes.length) {
    return { chosen: null, verdict: "none-available", message: `No cluster instance types exist, so the VM will be sized explicitly at ${req.cpuCores} vCPU / ${req.memoryMi}Mi.` };
  }

  const wantCpu = req.cpuCores, wantMem = req.memoryMi;
  // Prefer a type that meets or exceeds both, smallest first.
  const fits = instanceTypes
    .filter((i) => i.cpu >= wantCpu && parseMemToMi(i.memory) >= wantMem)
    .sort((a, b) => (a.cpu - b.cpu) || (parseMemToMi(a.memory) - parseMemToMi(b.memory)));
  const chosen = fits[0] || null;
  if (!chosen) {
    const biggest = instanceTypes[instanceTypes.length - 1];
    return {
      chosen: null, verdict: "exceeds-catalogue", biggest,
      message: `Nothing in the catalogue reaches ${wantCpu} vCPU / ${Math.round(wantMem / 1024)}Gi — the largest is ${biggest.name} (${biggest.cpu} vCPU / ${biggest.memory}). This needs an explicit size and an exception.`,
    };
  }
  const cMem = parseMemToMi(chosen.memory);
  const exact = chosen.cpu === wantCpu && cMem === wantMem;
  const cpuOver = chosen.cpu - wantCpu;
  const memOverGi = Math.round(((cMem - wantMem) / 1024) * 10) / 10;
  const alternatives = fits.slice(1, 3);
  return {
    chosen, alternatives,
    verdict: exact ? "exact" : "rounded-up",
    requested: { cpu: wantCpu, memoryMi: wantMem },
    delta: { cpu: cpuOver, memoryGi: memOverGi },
    message: exact
      ? `You asked for ${wantCpu} vCPU / ${Math.round(wantMem / 1024)}Gi. The standard size ${chosen.name} is an exact match.`
      : `You asked for ${wantCpu} vCPU / ${Math.round(wantMem / 1024)}Gi. The nearest standard size is ${chosen.name} (${chosen.cpu} vCPU / ${chosen.memory})`
        + `${cpuOver || memOverGi ? ` — that is ${[cpuOver ? `+${cpuOver} vCPU` : null, memOverGi ? `+${memOverGi}Gi` : null].filter(Boolean).join(" and ")} more than requested.` : "."}`,
  };
}

// ---------------------------------------------------------------------------
// 4. Pre-flight against the live cluster
// ---------------------------------------------------------------------------
/**
 * Everything that would make the request fail, or make it a bad idea, checked
 * before anyone is asked to approve it.
 * @returns {{ok:boolean, blocking:Array, warnings:Array, quota:object|null}}
 */
export async function preflightVMRequest(req) {
  const blocking = [], warnings = [];
  const names = vmNames(req);

  if (!req.namespace) blocking.push({ code: "no-namespace", message: "No namespace specified." });
  else if (PROTECTED_NS.some((re) => re.test(req.namespace))) {
    blocking.push({ code: "protected-namespace", message: `"${req.namespace}" is a platform namespace — VMs must not be provisioned there.` });
  }

  // A namespace that does not exist yet is only a blocker if nobody intends to
  // create it. When the request opts in, it becomes a warning — the operator
  // has been told plainly what provisioning will also do.
  if (req.namespace && !PROTECTED_NS.some((re) => re.test(req.namespace))) {
    try {
      await ocpGet(`/api/v1/namespaces/${req.namespace}`);
    } catch {
      if (req.createNamespace) {
        warnings.push({ code: "namespace-will-be-created", message: `Namespace "${req.namespace}" does not exist and will be created as part of provisioning.` });
      } else {
        blocking.push({ code: "namespace-missing", message: `Namespace "${req.namespace}" does not exist. Tick "create it" on the request, or pick an existing namespace.` });
      }
    }
  }

  // Name collisions — check every name we would create.
  for (const n of names) {
    try {
      await ocpGet(`/${KUBEVIRT_API}/namespaces/${req.namespace}/virtualmachines/${n}`);
      blocking.push({ code: "name-taken", message: `A VM named "${n}" already exists in ${req.namespace}.` });
    } catch { /* 404 is what we want */ }
  }

  // Boot source must exist and be ready, or the VM will sit importing forever.
  if (req.sourceDataSource) {
    try {
      const ds = await ocpGet(`/${CDI_API}/namespaces/${req.sourceDataSourceNamespace}/datasources/${req.sourceDataSource}`);
      const ready = (ds.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True");
      if (!ready) warnings.push({ code: "image-not-ready", message: `Golden image "${req.sourceDataSource}" is not reporting Ready — the VM may stay in import for a long time.` });
    } catch {
      blocking.push({ code: "image-missing", message: `Golden image DataSource "${req.sourceDataSource}" was not found in ${req.sourceDataSourceNamespace}.` });
    }
  }

  if (req.storageClass) {
    try { await ocpGet(`/apis/storage.k8s.io/v1/storageclasses/${req.storageClass}`); }
    catch { blocking.push({ code: "storageclass-missing", message: `Storage class "${req.storageClass}" does not exist.` }); }
  }

  if (req.networkAttachmentDefinition) {
    const [nadNs, nadName] = req.networkAttachmentDefinition.includes("/")
      ? req.networkAttachmentDefinition.split("/") : [req.namespace, req.networkAttachmentDefinition];
    try { await ocpGet(`/apis/k8s.cni.cncf.io/v1/namespaces/${nadNs}/network-attachment-definitions/${nadName}`); }
    catch { blocking.push({ code: "nad-missing", message: `NetworkAttachmentDefinition "${req.networkAttachmentDefinition}" was not found — the VM would have no network.` }); }
  }

  if (!req.sshKey) blocking.push({ code: "no-access", message: "No SSH key — the VM would boot with no way to log in." });

  // Quota headroom: what this request consumes, against what is left.
  const quota = await quotaImpact(req);
  if (quota?.exceeds?.length) {
    for (const e of quota.exceeds) {
      blocking.push({ code: "quota-exceeded", message: `Quota "${e.quota}" would be exceeded: ${e.resource} ${e.used} + ${e.requested} > ${e.hard}.` });
    }
  } else if (quota?.tight?.length) {
    for (const w of quota.tight) {
      warnings.push({ code: "quota-tight", message: `This takes ${w.resource} to ${w.afterPct}% of quota "${w.quota}".` });
    }
  }

  if (req.expiresOn) {
    const t = Date.parse(req.expiresOn);
    if (!Number.isFinite(t)) warnings.push({ code: "bad-expiry", message: `Expiry "${req.expiresOn}" is not a valid date — it will not be enforceable.` });
    else if (t < Date.now()) warnings.push({ code: "past-expiry", message: "The expiry date is in the past." });
  } else {
    warnings.push({ code: "no-expiry", message: "No expiry date set. VMs without one are how sprawl starts." });
  }
  if (!req.owner) warnings.push({ code: "no-owner", message: "No owner recorded — nobody to contact when this VM needs attention." });

  return { ok: blocking.length === 0, blocking, warnings, quota, names };
}

/** Compute what this request adds to each ResourceQuota in the namespace. */
async function quotaImpact(req) {
  if (!req.namespace) return null;
  let quotas;
  try { quotas = await ocpGet(`/api/v1/namespaces/${req.namespace}/resourcequotas`); }
  catch { return null; }
  const items = quotas.items || [];
  if (!items.length) return { quotas: [], exceeds: [], tight: [] };

  const n = Math.max(1, req.count || 1);
  const cpu = (req.cpuCores || 0) * n;
  const memMi = (req.memoryMi || 0) * n;
  const diskGi = (req.diskSizeGi || 0) * n;

  const exceeds = [], tight = [], summary = [];
  const parseCpu = (v) => (!v ? 0 : /m$/.test(v) ? parseFloat(v) / 1000 : parseFloat(v));
  for (const q of items) {
    const hard = q.status?.hard || q.spec?.hard || {};
    const used = q.status?.used || {};
    const checks = [
      { resource: "cpu", keys: ["requests.cpu", "cpu", "limits.cpu"], add: cpu, parse: parseCpu, unit: "" },
      { resource: "memory", keys: ["requests.memory", "memory", "limits.memory"], add: memMi, parse: parseMemToMi, unit: "Mi" },
      { resource: "storage", keys: ["requests.storage"], add: diskGi * 1024, parse: parseMemToMi, unit: "Mi" },
    ];
    for (const c of checks) {
      const key = c.keys.find((k) => hard[k] != null);
      if (!key || !c.add) continue;
      const h = c.parse(hard[key]), u = c.parse(used[key] || 0);
      const after = u + c.add;
      const pct = h > 0 ? Math.round((after / h) * 100) : 0;
      summary.push({ quota: q.metadata.name, resource: key, hard: hard[key], used: used[key] || "0", requested: `${c.add}${c.unit}`, afterPct: pct });
      if (after > h) exceeds.push({ quota: q.metadata.name, resource: key, hard: hard[key], used: used[key] || "0", requested: `${c.add}${c.unit}` });
      else if (pct >= 85) tight.push({ quota: q.metadata.name, resource: key, afterPct: pct });
    }
  }
  return { quotas: summary, exceeds, tight };
}

/** The VM names this request produces (name, or name-1..n for a batch). */
export function vmNames(req) {
  const n = Math.max(1, req.count || 1);
  if (!req.name) return [];
  return n === 1 ? [req.name] : Array.from({ length: n }, (_, i) => `${req.name}-${i + 1}`);
}

// ---------------------------------------------------------------------------
// 5. Manifest — the single source of truth, shared with the MCP tool
// ---------------------------------------------------------------------------
export function buildVMManifest(req, name = null) {
  const vmName = name || req.name;
  const dvName = `${vmName}-rootdisk`;
  const source = req.sourceDataSource
    ? { sourceRef: { kind: "DataSource", name: req.sourceDataSource, namespace: req.sourceDataSourceNamespace } }
    : req.sourceRegistryUrl ? { source: { registry: { url: req.sourceRegistryUrl } } }
    : req.sourceHttpUrl ? { source: { http: { url: req.sourceHttpUrl } } }
    : { source: { blank: {} } };

  const hostname = req.hostname || vmName;
  const userData = [
    "#cloud-config",
    `hostname: ${hostname}`,
    "ssh_pwauth: false",
    "users:",
    `  - name: ${req.username}`,
    "    sudo: ALL=(ALL) NOPASSWD:ALL",
    "    groups: wheel",
    "    shell: /bin/bash",
    "    ssh_authorized_keys:",
    `      - ${req.sshKey}`,
  ].join("\n");

  const useNad = Boolean(req.networkAttachmentDefinition);
  const iface = useNad ? { name: "nic-0", bridge: {} } : { name: "default", masquerade: {} };
  const network = useNad
    ? { name: "nic-0", multus: { networkName: req.networkAttachmentDefinition } }
    : { name: "default", pod: {} };

  const safe = (v) => String(v).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 63);
  const labels = {
    "kubevirt.io/vm": vmName,
    "app.kubernetes.io/managed-by": "tcs-agentic-ai",
    ...(req.environment ? { "tcs.ai/environment": safe(req.environment) } : {}),
    ...(req.owner ? { "tcs.ai/owner": safe(req.owner) } : {}),
    ...(req.costCentre ? { "tcs.ai/cost-centre": safe(req.costCentre) } : {}),
  };
  const annotations = {
    "tcs.ai/provisioned-at": nowIso(),
    "tcs.ai/provisioned-by": "tcs-agentic-ai",
    ...(req.owner ? { "tcs.ai/owner": req.owner } : {}),
    ...(req.requestId ? { "tcs.ai/request-id": req.requestId } : {}),
    ...(req.expiresOn ? { "tcs.ai/expires-on": req.expiresOn } : {}),
    ...(req.sizingRationale ? { "tcs.ai/sizing-rationale": req.sizingRationale } : {}),
  };

  const vm = {
    apiVersion: "kubevirt.io/v1",
    kind: "VirtualMachine",
    metadata: { name: vmName, namespace: req.namespace, labels, annotations },
    spec: {
      runStrategy: req.runStrategy,
      dataVolumeTemplates: [{
        metadata: { name: dvName },
        spec: {
          ...source,
          storage: {
            resources: { requests: { storage: `${req.diskSizeGi}Gi` } },
            ...(req.storageClass ? { storageClassName: req.storageClass } : {}),
          },
        },
      }],
      template: {
        metadata: { labels: { "kubevirt.io/vm": vmName, ...(req.environment ? { "tcs.ai/environment": safe(req.environment) } : {}) } },
        spec: {
          domain: { devices: { disks: [
            { name: "rootdisk", disk: { bus: "virtio" } },
            { name: "cloudinit", disk: { bus: "virtio" } },
          ], interfaces: [iface] } },
          networks: [network],
          volumes: [
            { name: "rootdisk", dataVolume: { name: dvName } },
            { name: "cloudinit", cloudInitNoCloud: { userData } },
          ],
        },
      },
    },
  };
  if (req.instanceType) vm.spec.instancetype = { kind: "VirtualMachineClusterInstancetype", name: req.instanceType };
  else {
    vm.spec.template.spec.domain.cpu = { cores: req.cpuCores || 2 };
    vm.spec.template.spec.domain.memory = { guest: `${req.memoryMi || 4096}Mi` };
  }
  if (req.preference) vm.spec.preference = { kind: "VirtualMachineClusterPreference", name: req.preference };
  return vm;
}

// ---------------------------------------------------------------------------
// 6. Dry-run and provision
// ---------------------------------------------------------------------------
export async function dryRunVMRequest(req) {
  const missing = missingFields(req);
  if (missing.length) return { ok: false, error: `Incomplete request — missing: ${missing.join(", ")}` };
  const results = [];
  for (const name of vmNames(req)) {
    const manifest = buildVMManifest(req, name);
    try {
      await ocpPost(`/${KUBEVIRT_API}/namespaces/${req.namespace}/virtualmachines?dryRun=All`, manifest);
      results.push({ name, ok: true, message: `virtualmachine.kubevirt.io/${name} created (server dry run)` });
    } catch (e) {
      results.push({ name, ok: false, message: e.message });
    }
  }
  const ok = results.every((r) => r.ok);
  return {
    ok, results,
    terminal: [
      `$ oc apply -f vm-${req.name}.yaml --dry-run=server -n ${req.namespace}`,
      ...results.map((r) => (r.ok ? r.message : `Error: ${r.message}`)),
      "",
      ok ? "# validated by the API server — nothing was created" : "# dry run failed — nothing was created",
    ],
  };
}

/**
 * Provision for real. Human-approved by construction: the caller is an
 * operator-initiated route, and there is deliberately no autonomous path here.
 */
export async function provisionVMRequest(req, { actor = "operator", cluster = "local" } = {}) {
  const missing = missingFields(req);
  if (missing.length) return { ok: false, error: `Incomplete request — missing: ${missing.join(", ")}` };

  const pre = await preflightVMRequest(req);
  if (!pre.ok) return { ok: false, error: "Pre-flight failed", blocking: pre.blocking };

  const created = [], failed = [], terminal = [];

  // Create the namespace first when the operator asked for it. Pre-flight has
  // already confirmed it is not a platform namespace.
  if (req.createNamespace) {
    try {
      await ocpGet(`/api/v1/namespaces/${req.namespace}`);
    } catch {
      terminal.push(`$ oc create namespace ${req.namespace}`);
      try {
        await ocpPost(`/api/v1/namespaces`, {
          apiVersion: "v1", kind: "Namespace",
          metadata: {
            name: req.namespace,
            labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai" },
            annotations: {
              "openshift.io/display-name": req.namespace,
              ...(req.owner ? { "tcs.agentic-ai/owner": req.owner } : {}),
              ...(req.costCentre ? { "tcs.agentic-ai/cost-centre": req.costCentre } : {}),
            },
          },
        });
        terminal.push(`namespace/${req.namespace} created`);
      } catch (e) {
        return { ok: false, error: `Could not create namespace "${req.namespace}": ${e.message}`, terminal };
      }
    }
  }

  for (const name of vmNames(req)) {
    const manifest = buildVMManifest(req, name);
    terminal.push(`$ oc apply -f vm-${name}.yaml -n ${req.namespace}`);
    try {
      const r = await ocpPost(`/${KUBEVIRT_API}/namespaces/${req.namespace}/virtualmachines`, manifest);
      created.push({ name, uid: r.metadata?.uid || null });
      terminal.push(`virtualmachine.kubevirt.io/${name} created`);
      // Ledger it, with decommission as the inverse. This is what makes the VM
      // recognisable later as something the platform provisioned.
      await recordChange({
        cluster, namespace: req.namespace, resourceKind: "virtualmachine", resourceName: name,
        action: "provision_vm", command: `oc apply -f vm-${name}.yaml -n ${req.namespace}`,
        risk: "medium",
        approvedBy: actor,
        incidentNumber: req.requestId || null,
        beforeValue: "(did not exist)",
        afterValue: [
          req.instanceType || `${req.cpuCores}vCPU/${req.memoryMi}Mi`,
          `${req.diskSizeGi}Gi disk`,
          req.owner ? `owner ${req.owner}` : null,
          req.environment || null,
          req.expiresOn ? `expires ${req.expiresOn}` : null,
        ].filter(Boolean).join(", "),
        revertable: true,
        revertReason: "Decommission the VM and release its root disk.",
        revertCommand: `oc delete virtualmachine ${name} -n ${req.namespace}`,
        applyOutput: `virtualmachine.kubevirt.io/${name} created`,
      }).catch(() => {});
    } catch (e) {
      failed.push({ name, error: e.message });
      terminal.push(`Error: ${e.message}`);
    }
  }
  terminal.push("", `$ oc get vm -n ${req.namespace}`);
  return {
    ok: failed.length === 0, created, failed, terminal,
    warnings: pre.warnings,
    message: failed.length === 0
      ? `${created.length} VM(s) created in ${req.namespace}. The root disk imports first; each VM boots when its DataVolume is ready.`
      : `${created.length} created, ${failed.length} failed.`,
  };
}

/** Optional ServiceNow change record for the provisioning action. */
export async function raiseProvisioningCR(req, preflight) {
  const { createChangeRequest } = await import("../utils/servicenow-client.js");
  const names = vmNames(req);
  return createChangeRequest({
    shortDescription: `Provision ${names.length} VM(s) in ${req.namespace}: ${names.join(", ")}`,
    description: [
      `Requested by : ${req.owner || "unspecified"}`,
      `Namespace    : ${req.namespace}`,
      `Image        : ${req.sourceDataSource}`,
      `Sizing       : ${req.instanceType || `${req.cpuCores} vCPU / ${req.memoryMi}Mi`}`,
      `Root disk    : ${req.diskSizeGi}Gi${req.storageClass ? ` (${req.storageClass})` : ""}`,
      `Network      : ${req.networkAttachmentDefinition || "pod network"}`,
      `Environment  : ${req.environment || "unspecified"}`,
      `Cost centre  : ${req.costCentre || "unspecified"}`,
      `Expires on   : ${req.expiresOn || "NOT SET"}`,
      req.sizingRationale ? `Rationale    : ${req.sizingRationale}` : null,
      "",
      preflight?.warnings?.length ? `Pre-flight warnings:\n${preflight.warnings.map((w) => ` - ${w.message}`).join("\n")}` : "Pre-flight clean.",
    ].filter(Boolean).join("\n"),
    type: "normal",
    category: "Infrastructure",
    risk: req.environment === "prod" ? "moderate" : "low",
    implementationPlan: names.map((n) => `oc apply -f vm-${n}.yaml -n ${req.namespace}`).join("\n"),
    backoutPlan: names.map((n) => `oc delete virtualmachine ${n} -n ${req.namespace}`).join("\n"),
    testPlan: `oc get vm -n ${req.namespace}; verify each VM reaches Running and accepts SSH as ${req.username}.`,
  });
}

/**
 * One call for the console card: extract, reconcile against this cluster, and
 * pre-flight — everything needed to render a decision.
 */
export async function buildVMRequestCard(text, overrides = {}) {
  const { request: extracted, missing: m0, source, provided } = await extractVMRequest(text);
  const request = normalizeVMRequest({ ...extracted, ...overrides });
  const catalogue = await listProvisionables(request.sourceDataSourceNamespace);

  // Suggest a golden image from the OS text when one was not named outright.
  if (!request.sourceDataSource && request.os) {
    const want = String(request.os).toLowerCase().replace(/[^a-z0-9]/g, "");
    const hit = catalogue.images.find((i) => want.startsWith(i.name.toLowerCase().replace(/[^a-z0-9]/g, ""))
      || i.name.toLowerCase().replace(/[^a-z0-9]/g, "").startsWith(want));
    if (hit) request.sourceDataSource = hit.name;
  }
  const reconciliation = reconcileSizing(request, catalogue.instanceTypes);
  if (reconciliation.chosen && !request.instanceType) request.instanceType = reconciliation.chosen.name;

  const preflight = request.namespace ? await preflightVMRequest(request) : null;
  return {
    request, catalogue, reconciliation, preflight,
    missing: missingFields(request),
    provided: [...new Set([...(provided || []), ...Object.keys(overrides || {})])],
    extractedBy: source,
    initiallyMissing: m0,
  };
}

// ---------------------------------------------------------------------------
// Runtime status — what actually happened after provisioning
// ---------------------------------------------------------------------------
/**
 * Live state of one or more provisioned VMs.
 *
 * "Created" is not "running": the root disk is imported from a golden image
 * first, and on a slow registry that takes minutes. Reporting the VM as done
 * the moment the object exists is the same mistake as calling a Deployment
 * healthy because its pods are Ready — so this reads the DataVolume import
 * progress, the VirtualMachineInstance phase, and any condition explaining a
 * stall, and says which of those the VM is actually in.
 *
 * @returns {{namespace:string, vms:Array, allRunning:boolean, anyFailed:boolean}}
 */
export async function vmRuntimeStatus(namespace, names = []) {
  const safe = async (p) => { try { return await ocpGet(p); } catch { return null; } };
  const [dvList, eventList] = await Promise.all([
    safe(`/${CDI_API}/namespaces/${namespace}/datavolumes`),
    safe(`/api/v1/namespaces/${namespace}/events?fieldSelector=type!=Normal&limit=100`),
  ]);

  const vms = [];
  for (const name of names) {
    const vm = await safe(`/${KUBEVIRT_API}/namespaces/${namespace}/virtualmachines/${name}`);
    if (!vm) {
      vms.push({ name, phase: "missing", status: "Not found", detail: `No VirtualMachine "${name}" in ${namespace}.`, ready: false, failed: true });
      continue;
    }
    const vmi = await safe(`/${KUBEVIRT_API}/namespaces/${namespace}/virtualmachineinstances/${name}`);
    const conds = [...(vm.status?.conditions || []), ...(vmi?.status?.conditions || [])];
    const bad = conds.find((c) => c.status === "False" && ["Ready", "Initialized"].includes(c.type) && c.reason)
             || conds.find((c) => c.type === "Failure" && c.status === "True");

    // Disk import — the usual reason a VM sits not-running for minutes.
    const dvs = (dvList?.items || []).filter((d) =>
      d.metadata?.name === name || (d.metadata?.ownerReferences || []).some((o) => o.name === name));
    const disks = dvs.map((d) => ({
      name: d.metadata.name,
      phase: d.status?.phase || "Unknown",
      progress: d.status?.progress || null,
      reason: (d.status?.conditions || []).find((c) => c.type === "Running" && c.status === "False")?.reason || null,
    }));
    const importing = disks.find((d) => !["Succeeded", "", null, undefined].includes(d.phase) && d.phase !== "Succeeded");

    const vmiPhase = vmi?.status?.phase || null;                 // Pending|Scheduling|Scheduled|Running|Succeeded|Failed
    const printable = vm.status?.printableStatus || null;        // Starting|Running|Stopped|Provisioning|…
    const ready = vmiPhase === "Running" && (vm.status?.ready === true || conds.some((c) => c.type === "Ready" && c.status === "True"));

    let phase, status, detail;
    if (ready) {
      phase = "running"; status = "Running";
      const ips = (vmi?.status?.interfaces || []).map((i) => i.ipAddress).filter(Boolean);
      const agent = conds.some((c) => c.type === "AgentConnected" && c.status === "True");
      detail = `Guest is up on ${vmi?.status?.nodeName || "a node"}${ips.length ? ` · ${ips.join(", ")}` : ""}${agent ? " · guest agent connected" : " · guest agent not reporting yet"}.`;
    } else if (vmiPhase === "Failed" || bad) {
      phase = "failed"; status = printable || "Failed";
      detail = bad ? `${bad.reason}${bad.message ? ` — ${bad.message}` : ""}` : "The virtual machine instance reported Failed.";
    } else if (importing) {
      phase = "provisioning"; status = "Provisioning — importing disk";
      detail = `Root disk ${importing.name}: ${importing.phase}${importing.progress ? ` (${importing.progress})` : ""}. The VM starts once the import completes.`;
    } else if (vmiPhase) {
      phase = "starting"; status = printable || vmiPhase;
      detail = `Instance is ${vmiPhase.toLowerCase()} — waiting for the guest to boot.`;
    } else {
      phase = "provisioning"; status = printable || "Provisioning";
      detail = "The VirtualMachine exists; no instance is running yet.";
    }

    // Anything the cluster complained about for this VM, in its own words.
    const events = (eventList?.items || [])
      .filter((e) => e.involvedObject?.name === name || (e.involvedObject?.name || "").startsWith(`virt-launcher-${name}`))
      .slice(-3)
      .map((e) => `${e.reason}: ${(e.message || "").slice(0, 180)}`);

    vms.push({
      name, phase, status, detail, ready, failed: phase === "failed",
      node: vmi?.status?.nodeName || null,
      ips: (vmi?.status?.interfaces || []).map((i) => i.ipAddress).filter(Boolean),
      disks, events,
      created: vm.metadata?.creationTimestamp || null,
    });
  }

  return {
    namespace, vms,
    allRunning: vms.length > 0 && vms.every((v) => v.ready),
    anyFailed: vms.some((v) => v.failed),
    checkedAt: new Date().toISOString(),
  };
}
