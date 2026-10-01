/**
 * Remediation for the App Deployment Agent's pre-deploy gate.
 *
 * A gate that only says "9 of 10" is homework. This takes the manifests and the
 * profile, applies the fixes that can be derived from the finding itself, and
 * returns a UNIFIED DIFF of what it changed — so a human reads the change, not
 * a promise, and decides whether to take it. Nothing is applied to a cluster
 * here and nothing is written anywhere: the output is YAML plus a diff.
 *
 * Three rules it keeps:
 *   1. Every fix is attributed to the control it closes.
 *   2. Every fix declares its risk. "safe" means the change cannot alter how
 *      the workload runs. "verify" means it can — dropping capabilities from
 *      something binding port 80, inventing a memory limit, forcing a root-only
 *      image to non-root. Those are still offered, never silently taken.
 *   3. What it cannot fix from the finding alone, it says it cannot fix, with
 *      the reason. A remediation that pretends is worse than none.
 */

import yaml from "js-yaml";
import { resolveProfile } from "./policy-profiles.js";

// Same defaults the generator uses, for the same reason (CIS-5.2.4 and any
// ResourceQuota), and flagged the same way: assumed, not read.
const FALLBACK_RESOURCES = {
  requests: { cpu: "100m", memory: "128Mi" },
  limits: { cpu: "500m", memory: "512Mi" },
};

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

// ── Minimal unified diff (LCS over lines) ─────────────────────────────────
// No dependency added for this: the manifests are tens of lines, and a diff a
// reviewer has to trust should be readable code.
function lcsMatrix(a, b) {
  const m = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      m[i][j] = a[i] === b[j] ? m[i + 1][j + 1] + 1 : Math.max(m[i + 1][j], m[i][j + 1]);
    }
  }
  return m;
}

/** Unified diff of two texts, with `context` lines around each hunk. */
export function unifiedDiff(aText, bText, { aName = "a", bName = "b", context = 3 } = {}) {
  const a = String(aText).replace(/\n$/, "").split("\n");
  const b = String(bText).replace(/\n$/, "").split("\n");
  const m = lcsMatrix(a, b);
  const ops = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ t: " ", line: a[i] }); i++; j++; }
    else if (m[i + 1][j] >= m[i][j + 1]) { ops.push({ t: "-", line: a[i] }); i++; }
    else { ops.push({ t: "+", line: b[j] }); j++; }
  }
  while (i < a.length) ops.push({ t: "-", line: a[i++] });
  while (j < b.length) ops.push({ t: "+", line: b[j++] });
  if (!ops.some((o) => o.t !== " ")) return "";

  // Group changes into hunks with `context` unchanged lines on each side.
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, k) => {
    if (o.t === " ") return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = true;
  });
  const out = [`--- ${aName}`, `+++ ${bName}`];
  let aNo = 1, bNo = 1, k = 0;
  while (k < ops.length) {
    if (!keep[k]) { if (ops[k].t !== "+") aNo++; if (ops[k].t !== "-") bNo++; k++; continue; }
    const aStart = aNo, bStart = bNo;
    const body = [];
    let aLen = 0, bLen = 0;
    while (k < ops.length && keep[k]) {
      const o = ops[k++];
      body.push(o.t + o.line);
      if (o.t !== "+") { aNo++; aLen++; }
      if (o.t !== "-") { bNo++; bLen++; }
    }
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`, ...body);
  }
  return out.join("\n") + "\n";
}

// ── The fixes ─────────────────────────────────────────────────────────────
function slug(s) {
  return String(s || "app").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "app";
}

/**
 * Remediate a manifest set against a profile.
 *
 * Returns { patched, manifests, yaml, diff, fixes, unfixable, profile, counts }
 *   patched   — true if anything changed
 *   manifests — the patched objects (deep copies; the input is never mutated)
 *   yaml      — the patched set as multi-document YAML
 *   diff      — unified diff, original → patched
 *   fixes     — [{ control, target, change, risk, why }]
 *   unfixable — [{ control, target, why }]
 */
export function remediateManifests(manifests, opts = {}) {
  const profile = resolveProfile(opts.profile);
  const inProfile = (id) => profile.controls.includes(id);
  const before = toYaml(manifests);
  const out = JSON.parse(JSON.stringify(manifests));
  const fixes = [];
  const unfixable = [];
  const added = [];
  const fix = (control, target, change, risk, why) => fixes.push({ control, target, change, risk, why });

  const workloads = out.map((m) => ({ m, ps: podSpecOf(m) })).filter((w) => w.ps);
  const appName = slug(out.find((m) => m.metadata?.name)?.metadata?.name || "app");
  const nsOf = (m) => m.metadata?.namespace || opts.namespace || out.find((x) => (x.kind || "").toLowerCase() === "namespace")?.metadata?.name || "default";

  for (const { m, ps } of workloads) {
    const label = `${m.kind}/${m.metadata?.name || "?"}`;

    // CIS-5.2.7 — host namespaces. Removing them is the only possible fix, and
    // a workload that genuinely needs the host network will stop working, so
    // this is offered, not assumed.
    if (inProfile("CIS-5.2.7")) {
      for (const key of ["hostNetwork", "hostPID", "hostIPC"]) {
        if (ps[key] === true) {
          delete ps[key];
          fix("CIS-5.2.7", label, `removed ${key}: true`, "verify",
            `A pod in the host's ${key === "hostNetwork" ? "network" : key === "hostPID" ? "process" : "IPC"} namespace cannot be admitted under restricted. If the workload truly needs it, it needs its own namespace and an SCC exception instead of this fix.`);
        }
      }
    }

    // CIS-5.2.6 / 5.2.9 — pod-level context.
    const podCtx = ps.securityContext || {};
    if (inProfile("CIS-5.2.6") && podCtx.runAsNonRoot !== true &&
        !containersOf(ps).every((c) => c.securityContext?.runAsNonRoot === true)) {
      podCtx.runAsNonRoot = true;
      fix("CIS-5.2.6", label, "set spec.securityContext.runAsNonRoot: true", "verify",
        "An image whose entrypoint needs root (binds a privileged port, chowns a data directory, writes to /etc) will now fail to start. Check the image runs under an arbitrary UID before taking this.");
    }
    if (inProfile("CIS-5.2.9") && podCtx.seccompProfile?.type !== "RuntimeDefault" &&
        !containersOf(ps).every((c) => c.securityContext?.seccompProfile?.type === "RuntimeDefault")) {
      podCtx.seccompProfile = { type: "RuntimeDefault" };
      fix("CIS-5.2.9", label, "set spec.securityContext.seccompProfile.type: RuntimeDefault", "safe",
        "The default syscall filter. Only a workload making unusual syscalls (a debugger, a profiler, some JVM agents) notices.");
    }
    if (Object.keys(podCtx).length) ps.securityContext = podCtx;

    // CIS-5.1.6 — never the default ServiceAccount.
    if (inProfile("CIS-5.1.6") && (!ps.serviceAccountName || ps.serviceAccountName === "default")) {
      const saName = `${slug(m.metadata?.name || appName)}-sa`;
      ps.serviceAccountName = saName;
      if (!out.some((x) => (x.kind || "").toLowerCase() === "serviceaccount" && x.metadata?.name === saName)) {
        const sa = {
          apiVersion: "v1", kind: "ServiceAccount",
          metadata: { name: saName, namespace: nsOf(m), labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai" } },
          automountServiceAccountToken: false,
        };
        out.push(sa); added.push(`ServiceAccount/${saName}`);
      }
      fix("CIS-5.1.6", label, `set serviceAccountName: ${saName} and added that ServiceAccount`, "safe",
        "The default ServiceAccount is shared by everything in the namespace, so any RoleBinding on it leaks to every workload. The new account has no bindings and no mounted token.");
    }

    // Container-level controls.
    for (const c of containersOf(ps)) {
      const t = `${label}:${c.name || "?"}`;
      const cc = c.securityContext || {};

      if (inProfile("CIS-5.2.1") && cc.privileged === true) {
        delete cc.privileged;
        fix("CIS-5.2.1", t, "removed privileged: true", "verify",
          "A privileged container has the host's capabilities and devices. If this is a CNI, CSI or monitoring agent that needs them, it does not belong in an application namespace under restricted.");
      }
      if (inProfile("CIS-5.2.5") && cc.allowPrivilegeEscalation !== false) {
        cc.allowPrivilegeEscalation = false;
        fix("CIS-5.2.5", t, "set allowPrivilegeEscalation: false", "safe",
          "Blocks setuid binaries from gaining capabilities the pod was not granted. Breaks only a container that relies on a setuid helper such as ping or sudo.");
      }
      if (inProfile("CIS-5.2.8") && !(cc.capabilities?.drop || []).map(String).map((s) => s.toUpperCase()).includes("ALL")) {
        const lowPort = (c.ports || []).some((p) => Number(p.containerPort) > 0 && Number(p.containerPort) < 1024);
        cc.capabilities = { ...(cc.capabilities || {}), drop: ["ALL"] };
        fix("CIS-5.2.8", t, "set capabilities.drop: [ALL]", lowPort ? "verify" : "safe",
          lowPort
            ? `This container binds port ${(c.ports || []).find((p) => Number(p.containerPort) < 1024)?.containerPort}, which needs NET_BIND_SERVICE. Change the container to listen above 1024 and point the Service at it — adding the capability back defeats the control.`
            : "Linux capabilities are the privileges a non-root process can still hold. Nothing in a normal application server uses them.");
      }
      if (Object.keys(cc).length) c.securityContext = cc;

      // CIS-5.2.4 — requests and limits.
      if (inProfile("CIS-5.2.4") && !(c.resources?.limits?.cpu && c.resources?.limits?.memory)) {
        const r = c.resources || {};
        r.requests = { ...FALLBACK_RESOURCES.requests, ...(r.requests || {}) };
        r.limits = { ...FALLBACK_RESOURCES.limits, ...(r.limits || {}) };
        c.resources = r;
        fix("CIS-5.2.4", t, `set resources (requests ${r.requests.cpu}/${r.requests.memory}, limits ${r.limits.cpu}/${r.limits.memory})`, "verify",
          "These numbers are NOT measured — they are a placeholder so the pod is schedulable and quota-admissible. A memory limit below what the workload uses causes an OOMKill; size it from the application's real footprint before production.");
      }

      // CIS-5.4.1 — plaintext credentials in env. Fixable, by moving the value
      // into a generated Secret and referencing it.
      if (inProfile("CIS-5.4.1")) {
        const credRe = /(pass|password|secret|token|apikey|api_key)/i;
        const plain = (c.env || []).filter((e) => credRe.test(e.name || "") && typeof e.value === "string" && e.value.length > 0 && !e.valueFrom);
        if (plain.length) {
          const secName = `${slug(m.metadata?.name || appName)}-env`;
          let sec = out.find((x) => (x.kind || "").toLowerCase() === "secret" && x.metadata?.name === secName);
          if (!sec) {
            sec = { apiVersion: "v1", kind: "Secret", metadata: { name: secName, namespace: nsOf(m), labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai" } }, type: "Opaque", data: {} };
            out.push(sec); added.push(`Secret/${secName}`);
          }
          for (const e of plain) {
            sec.data[e.name] = Buffer.from(String(e.value)).toString("base64");
            delete e.value;
            e.valueFrom = { secretKeyRef: { name: secName, key: e.name } };
          }
          fix("CIS-5.4.1", t, `moved ${plain.map((e) => e.name).join(", ")} into Secret/${secName} and referenced via secretKeyRef`, "verify",
            "The value is now base64 in a Secret manifest, which is encoding and not encryption — this closes the control but the credential is still in the file. Rotate it, or point the reference at a Secret your vault or External Secrets Operator creates.");
        }
      }
    }

    // readOnlyRootFilesystem is deliberately never auto-set — see the generator.
  }

  // CIS-5.3.2 — a NetworkPolicy must exist for the namespace.
  if (inProfile("CIS-5.3.2") && !out.some((m) => (m.kind || "").toLowerCase() === "networkpolicy")) {
    const ns = workloads.length ? nsOf(workloads[0].m) : (opts.namespace || "default");
    out.push({
      apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy",
      metadata: { name: "default-deny-all", namespace: ns, labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai" } },
      spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
    });
    added.push("NetworkPolicy/default-deny-all");
    fix("CIS-5.3.2", `Namespace/${ns}`, "added a default-deny NetworkPolicy (ingress and egress)", "verify",
      "This denies everything, including DNS. On its own it will break the application: add an egress allow to kube-dns and one allow per real traffic path, or generate from a document that declares the connectivity matrix.");
    unfixable.push({
      control: "CIS-5.3.2", target: `Namespace/${ns}`,
      why: "The allow rules cannot be derived from the manifests — which tier may talk to which, on what port, is a decision, not a reading. Default-deny was added; the allows are yours.",
    });
  }

  // Record what could not be closed from the findings alone.
  if (inProfile("CIS-5.2.6")) {
    for (const { m, ps } of workloads) {
      if (containersOf(ps).some((c) => c.securityContext?.runAsUser === 0)) {
        unfixable.push({
          control: "CIS-5.2.6", target: `${m.kind}/${m.metadata?.name}`,
          why: "The container asks for runAsUser: 0 explicitly. Removing it would contradict a stated requirement, so this needs a human decision: rebuild the image to run unprivileged, or move the workload to a namespace with an SCC that permits it.",
        });
      }
    }
  }

  const after = toYaml(out);
  const counts = {
    fixes: fixes.length,
    safe: fixes.filter((f) => f.risk === "safe").length,
    verify: fixes.filter((f) => f.risk === "verify").length,
    unfixable: unfixable.length,
    objectsAdded: added.length,
  };
  return {
    patched: after !== before,
    manifests: out,
    yaml: after,
    diff: unifiedDiff(before, after, { aName: "generated.yaml", bName: "remediated.yaml" }),
    fixes, unfixable, added, counts,
    profile: { id: profile.id, name: profile.name, version: profile.version },
  };
}

function toYaml(objs) {
  return objs.map((o) => yaml.dump(o, { lineWidth: -1, noRefs: true, sortKeys: false }).trimEnd()).join("\n---\n") + "\n";
}
