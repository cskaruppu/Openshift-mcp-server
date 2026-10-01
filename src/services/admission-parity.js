/**
 * Admission parity for the App Deployment Agent.
 *
 * Passing the agent's own gate and being admitted by the cluster are different
 * things, and the gap between them is where "it passed every check and then the
 * deploy failed" comes from. The cluster's answer depends on the TARGET
 * NAMESPACE, which the static gate never looks at:
 *
 *   · Pod Security Admission labels — a namespace labelled enforce=restricted
 *     rejects a pod the gate waved through under a baseline profile.
 *   · The namespace's UID range — OpenShift's SCC assigns a UID from
 *     openshift.io/sa.scc.uid-range, and a manifest with a hardcoded runAsUser
 *     outside that range is rejected.
 *   · A ResourceQuota — once one exists, a container with no limits is rejected,
 *     and a request that exceeds what is left is rejected too.
 *   · A LimitRange — can reject a container whose limit exceeds its maximum,
 *     and can also silently supply the limits the manifest omitted.
 *
 * The rule this follows: an unread namespace is reported as UNREAD. Not as
 * compatible, not as a pass. The whole point of the panel is to be trusted when
 * it says the deploy will be admitted, which is only possible if it admits when
 * it does not know.
 */

import { ocpGet } from "../utils/openshift-client.js";
import { statusOf } from "../utils/api-discovery.js";

const PSA_LEVELS = ["privileged", "baseline", "restricted"];
const WORKLOAD_KINDS = ["deployment", "statefulset", "daemonset", "replicaset", "job", "replicationcontroller"];

function podSpecOf(m) {
  const kind = (m.kind || "").toLowerCase();
  if (kind === "pod") return m.spec || null;
  if (kind === "cronjob") return m.spec?.jobTemplate?.spec?.template?.spec || null;
  if (WORKLOAD_KINDS.includes(kind)) return m.spec?.template?.spec || null;
  return null;
}
function containersOf(ps) {
  return [...(ps?.containers || []), ...(ps?.initContainers || [])];
}

/** Parse "1000680000/10000" into { min, max }. */
function parseUidRange(ann) {
  const m = /^(\d+)\/(\d+)$/.exec(String(ann || ""));
  if (!m) return null;
  const min = Number(m[1]), size = Number(m[2]);
  return { min, max: min + size - 1, raw: ann };
}

/** Does this pod spec satisfy Pod Security "restricted"/"baseline"? */
function psaViolations(ps, level) {
  const v = [];
  if (ps.hostNetwork === true) v.push("hostNetwork: true");
  if (ps.hostPID === true) v.push("hostPID: true");
  if (ps.hostIPC === true) v.push("hostIPC: true");
  for (const vol of ps.volumes || []) if (vol.hostPath) v.push(`hostPath volume "${vol.name}"`);
  for (const c of containersOf(ps)) {
    const sc = c.securityContext || {};
    const n = c.name || "?";
    if (sc.privileged === true) v.push(`${n}: privileged: true`);
    if ((sc.capabilities?.add || []).some((cap) => !["NET_BIND_SERVICE"].includes(String(cap).toUpperCase()))) {
      v.push(`${n}: adds capabilities ${(sc.capabilities.add || []).join(", ")}`);
    }
    if (level !== "restricted") continue;
    if (sc.allowPrivilegeEscalation !== false) v.push(`${n}: allowPrivilegeEscalation is not false`);
    if (!(sc.capabilities?.drop || []).map((x) => String(x).toUpperCase()).includes("ALL")) v.push(`${n}: capabilities.drop does not include ALL`);
    const seccomp = sc.seccompProfile?.type || ps.securityContext?.seccompProfile?.type;
    if (!["RuntimeDefault", "Localhost"].includes(seccomp)) v.push(`${n}: seccompProfile is not RuntimeDefault`);
    const nonRoot = sc.runAsNonRoot === true || ps.securityContext?.runAsNonRoot === true;
    const rootUid = sc.runAsUser === 0 || ps.securityContext?.runAsUser === 0;
    if (!nonRoot || rootUid) v.push(`${n}: not runAsNonRoot`);
  }
  return v;
}

/** Sum of container limits across a pod spec, in millicores and bytes. */
function parseCpu(s) {
  if (s === undefined || s === null) return null;
  const v = String(s);
  return v.endsWith("m") ? Number(v.slice(0, -1)) : Math.round(Number(v) * 1000);
}
function parseMem(s) {
  if (s === undefined || s === null) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(String(s));
  if (!m) return null;
  const mult = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  return Number(m[1]) * (m[2] ? mult[m[2]] : 1);
}
function human(bytes) {
  if (bytes === null) return "—";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0, v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${Math.round(v * 10) / 10}${u[i]}`;
}

/**
 * Compare the manifests against what the target namespace will actually admit.
 *
 * @returns {{
 *   namespace: string, namespaceState: "exists"|"absent"|"unread",
 *   psa: object, uidRange: object, quotas: array, limitRanges: array,
 *   findings: array, verdict: {status, summary}
 * }}
 */
export async function checkAdmissionParity(manifests, { namespace, read = ocpGet } = {}) {
  const objs = manifests.filter((m) => m && typeof m === "object");
  const nsName = namespace
    || objs.find((m) => (m.kind || "").toLowerCase() === "namespace")?.metadata?.name
    || objs.find((m) => m.metadata?.namespace)?.metadata?.namespace;

  const findings = [];
  const addFinding = (severity, control, title, detail, fix) =>
    findings.push({ severity, control, title, detail, fix: fix || null });

  if (!nsName) {
    return {
      namespace: null, namespaceState: "unread",
      psa: { read: false }, uidRange: null, quotas: [], limitRanges: [], findings: [],
      verdict: { status: "unknown", summary: "No target namespace could be determined from the manifests, so nothing about admission can be checked." },
    };
  }

  // ── Read the namespace ──
  let ns = null, nsState = "unread", nsError = null;
  try {
    ns = await read(`/api/v1/namespaces/${encodeURIComponent(nsName)}`);
    nsState = "exists";
  } catch (e) {
    const st = statusOf(e);
    if (st === 404) { nsState = "absent"; }
    else if (st === 403) { nsState = "unread"; nsError = `this service account may not read namespace/${nsName}`; }
    else if (st === 401) { nsState = "unread"; nsError = "the cluster rejected the credential"; }
    // Anything that is not an HTTP answer means we never reached a cluster.
    // The internal error text is not useful to the person reading the panel.
    else { nsState = "unread"; nsError = "the cluster could not be reached"; }
  }

  // A namespace this deploy will CREATE inherits the cluster's PSA defaults,
  // which cannot be read from here — and the manifest set may label it itself.
  const nsManifest = objs.find((m) => (m.kind || "").toLowerCase() === "namespace" && m.metadata?.name === nsName);
  const labels = { ...(ns?.metadata?.labels || {}), ...(nsState === "absent" ? (nsManifest?.metadata?.labels || {}) : {}) };
  const annotations = ns?.metadata?.annotations || {};

  const psa = {
    // The Namespace manifest in this set is only the authority when the
    // namespace does not exist yet. If the cluster could not be read, a
    // namespace that is already there may carry labels this manifest does not,
    // so "no enforce label" would be a claim about something unread.
    read: nsState === "exists" || (nsState === "absent" && !!nsManifest),
    source: nsState === "exists" ? "live namespace" : (nsState === "absent" && nsManifest) ? "the Namespace manifest in this set" : null,
    enforce: labels["pod-security.kubernetes.io/enforce"] || null,
    enforceVersion: labels["pod-security.kubernetes.io/enforce-version"] || null,
    audit: labels["pod-security.kubernetes.io/audit"] || null,
    warn: labels["pod-security.kubernetes.io/warn"] || null,
  };

  const uidRange = parseUidRange(annotations["openshift.io/sa.scc.uid-range"]);
  const supplementalGroups = annotations["openshift.io/sa.scc.supplemental-groups"] || null;

  // ── Quotas and LimitRanges in the namespace ──
  let quotas = [], limitRanges = [], quotaRead = false, lrRead = false;
  if (nsState === "exists") {
    try {
      const q = await read(`/api/v1/namespaces/${encodeURIComponent(nsName)}/resourcequotas`);
      quotaRead = true;
      quotas = (q.items || []).map((x) => ({ name: x.metadata?.name, hard: x.status?.hard || x.spec?.hard || {}, used: x.status?.used || {} }));
    } catch { /* unread — reported below, never assumed empty */ }
    try {
      const l = await read(`/api/v1/namespaces/${encodeURIComponent(nsName)}/limitranges`);
      lrRead = true;
      limitRanges = (l.items || []).map((x) => ({ name: x.metadata?.name, limits: x.spec?.limits || [] }));
    } catch { /* unread */ }
  }

  // ── The comparison ──
  const workloads = objs.map((m) => ({ m, ps: podSpecOf(m) })).filter((w) => w.ps);

  // 1. Pod Security Admission.
  if (psa.enforce && PSA_LEVELS.includes(psa.enforce)) {
    for (const { m, ps } of workloads) {
      const v = psaViolations(ps, psa.enforce);
      if (v.length) {
        addFinding("critical", "psa-enforce",
          `${m.kind}/${m.metadata?.name} will be REJECTED by Pod Security "${psa.enforce}"`,
          `The namespace enforces ${psa.enforce}${psa.enforceVersion ? ` (${psa.enforceVersion})` : ""}, and this pod spec violates it: ${v.join("; ")}.`,
          "Remediate the manifests (the gate's one-click fix closes most of these), or move the workload to a namespace whose enforce level permits it. Relaxing the namespace label is a security decision, not a deployment fix.");
      }
    }
    if (!findings.some((f) => f.control === "psa-enforce")) {
      addFinding("info", "psa-enforce", `Pod Security "${psa.enforce}" is satisfied`,
        `Every pod spec in this set satisfies the ${psa.enforce} profile the namespace enforces.`);
    }
  } else if (psa.read) {
    addFinding("warning", "psa-enforce", "The namespace enforces no Pod Security level",
      `namespace/${nsName} carries no pod-security.kubernetes.io/enforce label, so the admission controller will not reject an unhardened pod. The gate's verdict is then the only thing standing between a privileged pod and this namespace.`,
      'Label the namespace: oc label namespace ' + nsName + ' pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/audit=restricted pod-security.kubernetes.io/warn=restricted');
  } else {
    addFinding("warning", "psa-enforce", "The namespace's Pod Security level could not be read",
      nsState === "absent"
        ? `namespace/${nsName} does not exist yet and this manifest set does not create it with pod-security labels, so it will inherit whatever the cluster defaults to — which cannot be read from here.`
        : `namespace/${nsName} could not be read${nsError ? ` — ${nsError}` : ""}, so what admission will do is unknown.`,
      nsState === "absent"
        ? "Add pod-security.kubernetes.io/enforce|audit|warn: restricted to the Namespace manifest, so the level is declared rather than inherited."
        : "Grant this service account get on namespaces, or re-run against a reachable cluster.");
  }

  // 2. OpenShift's UID range vs a hardcoded runAsUser.
  for (const { m, ps } of workloads) {
    const uids = [
      ...(ps.securityContext?.runAsUser !== undefined ? [{ who: "pod", uid: ps.securityContext.runAsUser }] : []),
      ...containersOf(ps).filter((c) => c.securityContext?.runAsUser !== undefined).map((c) => ({ who: c.name, uid: c.securityContext.runAsUser })),
    ];
    for (const u of uids) {
      if (u.uid === 0) continue; // already covered by the PSA check
      if (uidRange && (u.uid < uidRange.min || u.uid > uidRange.max)) {
        addFinding("critical", "scc-uid-range",
          `${m.kind}/${m.metadata?.name} asks for UID ${u.uid}, outside this namespace's range`,
          `namespace/${nsName} is allocated ${uidRange.raw} (${uidRange.min}–${uidRange.max}). The restricted-v2 SCC will reject a pod requesting UID ${u.uid} (${u.who}).`,
          "Remove runAsUser entirely. OpenShift assigns a UID from the namespace range, and an image built to run under an arbitrary UID needs no runAsUser at all.");
      } else if (!uidRange && nsState === "exists") {
        addFinding("warning", "scc-uid-range",
          `${m.kind}/${m.metadata?.name} hardcodes UID ${u.uid} and the namespace's range is unknown`,
          `openshift.io/sa.scc.uid-range is not set or not readable on namespace/${nsName}, so whether UID ${u.uid} is permitted cannot be determined.`,
          "Remove runAsUser and let the SCC assign one.");
      }
    }
  }

  // 3. ResourceQuota — the classic "passed the gate, rejected by the cluster".
  const needsLimits = quotas.some((q) => Object.keys(q.hard || {}).some((k) => /^limits\.(cpu|memory)$|^requests\.(cpu|memory)$/.test(k)));
  if (quotaRead && quotas.length) {
    for (const { m, ps } of workloads) {
      for (const c of containersOf(ps)) {
        const missing = [];
        if (needsLimits && !c.resources?.limits?.cpu) missing.push("limits.cpu");
        if (needsLimits && !c.resources?.limits?.memory) missing.push("limits.memory");
        if (missing.length) {
          addFinding("critical", "resourcequota",
            `${m.kind}/${m.metadata?.name}:${c.name} has no ${missing.join(" / ")} and the namespace has a ResourceQuota`,
            `namespace/${nsName} carries ResourceQuota ${quotas.map((q) => q.name).join(", ")}, which constrains ${Object.keys(quotas[0].hard).filter((k) => k.startsWith("limits.") || k.startsWith("requests.")).join(", ")}. A container without those fields is rejected at admission with "must specify limits".`,
            "Set requests and limits on every container (the gate's one-click fix adds a placeholder), or add a LimitRange with defaults to the namespace.");
        }
      }
    }
    // Headroom: does what we are asking for still fit?
    const asked = workloads.reduce((a, { ps }) => {
      for (const c of containersOf(ps)) {
        const reps = 1;
        a.cpu += (parseCpu(c.resources?.limits?.cpu) || 0) * reps;
        a.mem += (parseMem(c.resources?.limits?.memory) || 0) * reps;
      }
      return a;
    }, { cpu: 0, mem: 0 });
    for (const q of quotas) {
      const hardCpu = parseCpu(q.hard["limits.cpu"]), usedCpu = parseCpu(q.used?.["limits.cpu"]);
      const hardMem = parseMem(q.hard["limits.memory"]), usedMem = parseMem(q.used?.["limits.memory"]);
      if (hardCpu !== null && usedCpu !== null && asked.cpu > hardCpu - usedCpu) {
        addFinding("critical", "resourcequota",
          `ResourceQuota ${q.name} does not have the CPU left for this deploy`,
          `This set asks for ${asked.cpu}m of CPU limits; ${hardCpu - usedCpu}m of ${hardCpu}m is unused. Admission rejects the pod that crosses the line — which means a PARTIAL deploy, some objects applied and some not.`,
          "Lower the limits, raise the quota, or deploy to a namespace with room.");
      }
      if (hardMem !== null && usedMem !== null && asked.mem > hardMem - usedMem) {
        addFinding("critical", "resourcequota",
          `ResourceQuota ${q.name} does not have the memory left for this deploy`,
          `This set asks for ${human(asked.mem)} of memory limits; ${human(hardMem - usedMem)} of ${human(hardMem)} is unused.`,
          "Lower the limits, raise the quota, or deploy to a namespace with room.");
      }
    }
  } else if (nsState === "exists" && !quotaRead) {
    addFinding("warning", "resourcequota", "The namespace's ResourceQuotas could not be read",
      `Whether namespace/${nsName} constrains CPU or memory is unknown, so a quota rejection cannot be ruled out.`,
      "Grant this service account list on resourcequotas in the namespace.");
  }

  // 4. LimitRange maxima.
  if (lrRead && limitRanges.length) {
    for (const lr of limitRanges) {
      for (const item of lr.limits) {
        if ((item.type || "") !== "Container") continue;
        const maxCpu = parseCpu(item.max?.cpu), maxMem = parseMem(item.max?.memory);
        for (const { m, ps } of workloads) {
          for (const c of containersOf(ps)) {
            const cpu = parseCpu(c.resources?.limits?.cpu), mem = parseMem(c.resources?.limits?.memory);
            if (maxCpu !== null && cpu !== null && cpu > maxCpu) {
              addFinding("critical", "limitrange",
                `${m.kind}/${m.metadata?.name}:${c.name} exceeds LimitRange ${lr.name} maximum CPU`,
                `The container asks for ${cpu}m; LimitRange ${lr.name} caps a container at ${item.max.cpu}.`,
                `Lower the CPU limit to ${item.max.cpu} or below.`);
            }
            if (maxMem !== null && mem !== null && mem > maxMem) {
              addFinding("critical", "limitrange",
                `${m.kind}/${m.metadata?.name}:${c.name} exceeds LimitRange ${lr.name} maximum memory`,
                `The container asks for ${human(mem)}; LimitRange ${lr.name} caps a container at ${item.max.memory}.`,
                `Lower the memory limit to ${item.max.memory} or below.`);
            }
          }
        }
      }
    }
  }

  // ── Verdict ──
  const critical = findings.filter((f) => f.severity === "critical").length;
  const warning = findings.filter((f) => f.severity === "warning").length;
  const unread = nsState === "unread" || (nsState === "exists" && !quotaRead) || !psa.read;
  const status = critical ? "will-be-rejected" : unread ? "unknown" : warning ? "admitted-with-gaps" : "will-be-admitted";
  const summary =
    critical ? `${critical} finding(s) mean the cluster will reject at least one object in this set — the agent's own gate cannot see these, because they depend on namespace/${nsName}.`
    : unread ? `Nothing in this set contradicts what could be read about namespace/${nsName}, but part of it could not be read — so this is "not known to fail", not "will be admitted".`
    : warning ? `Every object should be admitted to namespace/${nsName}, with ${warning} thing(s) worth knowing about the namespace itself.`
    : `Every object in this set satisfies what namespace/${nsName} enforces. Admission should not reject any of them.`;

  return {
    namespace: nsName,
    namespaceState: nsState,
    namespaceError: nsError,
    psa,
    uidRange: uidRange ? { ...uidRange, supplementalGroups } : null,
    quotas: quotaRead ? quotas : null,
    limitRanges: lrRead ? limitRanges : null,
    workloadCount: workloads.length,
    findings,
    verdict: { status, summary, critical, warning },
  };
}
