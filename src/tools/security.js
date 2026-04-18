import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

export function registerSecurityTools(server) {
  // ---------- RBAC Audit ----------
  server.tool(
    "security_rbac_audit",
    "Audit RBAC bindings — show which subjects (users/groups/SAs) have access to resources",
    {
      namespace: z.string().optional().describe("Namespace to audit (omit for cluster-wide)"),
      resource: z.string().optional().describe("Filter to a specific resource type, e.g. secrets, pods"),
    },
    async ({ namespace, resource }) => {
      try {
        const bindings = [];

        const crbs = await ocpGet("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings");
        for (const crb of (crbs.items || []).slice(0, 200)) {
          for (const subj of crb.subjects || []) {
            bindings.push({
              scope: "ClusterRoleBinding",
              binding: crb.metadata.name,
              role: crb.roleRef.name,
              roleKind: crb.roleRef.kind,
              subject: `${subj.kind}:${subj.namespace ? subj.namespace + "/" : ""}${subj.name}`,
            });
          }
        }

        if (namespace) {
          const rbs = await ocpGet(`/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`);
          for (const rb of (rbs.items || [])) {
            for (const subj of rb.subjects || []) {
              bindings.push({
                scope: `RoleBinding(${namespace})`,
                binding: rb.metadata.name,
                role: rb.roleRef.name,
                roleKind: rb.roleRef.kind,
                subject: `${subj.kind}:${subj.namespace ? subj.namespace + "/" : ""}${subj.name}`,
              });
            }
          }
        }

        let roleCache = {};
        async function resolveRules(kind, name) {
          const key = `${kind}/${name}`;
          if (roleCache[key]) return roleCache[key];
          try {
            const path = kind === "ClusterRole"
              ? `/apis/rbac.authorization.k8s.io/v1/clusterroles/${name}`
              : `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/roles/${name}`;
            const role = await ocpGet(path);
            roleCache[key] = role.rules || [];
          } catch { roleCache[key] = []; }
          return roleCache[key];
        }

        const results = [];
        for (const b of bindings.slice(0, 100)) {
          const rules = await resolveRules(b.roleKind, b.role);
          const matchedRules = resource
            ? rules.filter(r => (r.resources || []).some(res => res === resource || res === "*"))
            : rules;
          if (matchedRules.length > 0) {
            const verbs = [...new Set(matchedRules.flatMap(r => r.verbs || []))];
            const resources = [...new Set(matchedRules.flatMap(r => r.resources || []))];
            results.push(`${b.subject} via ${b.scope}/${b.binding} → role:${b.role}\n  Verbs: ${verbs.join(", ")}\n  Resources: ${resources.slice(0, 15).join(", ")}`);
          }
        }

        const header = `RBAC Audit${namespace ? ` (namespace: ${namespace})` : " (cluster-wide)"}${resource ? ` — resource: ${resource}` : ""}`;
        const text = results.length > 0
          ? `${header}\n${results.length} matching binding(s):\n\n${results.slice(0, 50).join("\n\n")}`
          : `${header}\nNo matching RBAC bindings found.`;
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `RBAC audit error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Who Can ----------
  server.tool(
    "security_rbac_who_can",
    "Find which subjects can perform a specific action — 'who can delete pods in namespace X?'",
    {
      verb: z.string().describe("Kubernetes verb: get, list, create, update, patch, delete, watch"),
      resource: z.string().describe("Resource type: pods, secrets, deployments, configmaps, etc."),
      namespace: z.string().optional().describe("Namespace scope (omit for cluster-wide)"),
    },
    async ({ verb, resource, namespace }) => {
      try {
        const subjects = [];
        const seen = new Set();

        async function checkBindings(bindingList, scope) {
          for (const binding of bindingList) {
            const roleKind = binding.roleRef.kind;
            const roleName = binding.roleRef.name;
            let rules = [];
            try {
              const path = roleKind === "ClusterRole"
                ? `/apis/rbac.authorization.k8s.io/v1/clusterroles/${roleName}`
                : `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/roles/${roleName}`;
              const role = await ocpGet(path);
              rules = role.rules || [];
            } catch { continue; }

            const canDo = rules.some(r =>
              (r.verbs || []).some(v => v === verb || v === "*") &&
              (r.resources || []).some(res => res === resource || res === "*")
            );
            if (!canDo) continue;

            for (const subj of binding.subjects || []) {
              const key = `${subj.kind}:${subj.namespace || ""}:${subj.name}`;
              if (seen.has(key)) continue;
              seen.add(key);
              subjects.push({
                kind: subj.kind,
                name: subj.name,
                namespace: subj.namespace || "",
                via: `${scope}/${binding.metadata.name} → ${roleName}`,
              });
            }
          }
        }

        const crbs = await ocpGet("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings");
        await checkBindings(crbs.items || [], "ClusterRoleBinding");

        if (namespace) {
          const rbs = await ocpGet(`/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`);
          await checkBindings(rbs.items || [], "RoleBinding");
        }

        const lines = subjects.slice(0, 50).map(s =>
          `- ${s.kind}: ${s.namespace ? s.namespace + "/" : ""}${s.name}\n  via ${s.via}`
        );
        const scope = namespace ? `in namespace ${namespace}` : "cluster-wide";
        const text = lines.length > 0
          ? `Who can "${verb} ${resource}" ${scope}?\n\n${subjects.length} subject(s) found:\n\n${lines.join("\n")}`
          : `No subjects found that can "${verb} ${resource}" ${scope}.`;
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Who-can error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Pod Security Audit ----------
  server.tool(
    "security_pod_security_audit",
    "Audit pods for security risks: privileged containers, running as root, hostNetwork, missing limits",
    {
      namespace: z.string().optional().describe("Namespace to audit (omit for all namespaces)"),
    },
    async ({ namespace }) => {
      try {
        const path = namespace ? `/api/v1/namespaces/${namespace}/pods` : "/api/v1/pods";
        const data = await ocpGet(path);
        const pods = (data.items || []).filter(p => p.status?.phase === "Running");

        const findings = [];
        for (const pod of pods.slice(0, 200)) {
          const podFindings = [];
          const containers = [...(pod.spec?.containers || []), ...(pod.spec?.initContainers || [])];

          for (const c of containers) {
            const sc = c.securityContext || {};
            const podSc = pod.spec?.securityContext || {};

            if (sc.privileged) podFindings.push({ severity: "CRITICAL", msg: `Container '${c.name}' runs privileged` });
            if (sc.runAsUser === 0 || podSc.runAsUser === 0) podFindings.push({ severity: "CRITICAL", msg: `Container '${c.name}' runs as root (UID 0)` });
            if (sc.allowPrivilegeEscalation !== false && !sc.privileged) podFindings.push({ severity: "WARNING", msg: `Container '${c.name}' allows privilege escalation` });
            if (!c.resources?.limits?.memory) podFindings.push({ severity: "WARNING", msg: `Container '${c.name}' has no memory limit` });
            if (!c.resources?.limits?.cpu) podFindings.push({ severity: "INFO", msg: `Container '${c.name}' has no CPU limit` });
            if (sc.capabilities?.add?.includes("SYS_ADMIN")) podFindings.push({ severity: "CRITICAL", msg: `Container '${c.name}' has SYS_ADMIN capability` });
            if (sc.capabilities?.add?.includes("NET_ADMIN")) podFindings.push({ severity: "WARNING", msg: `Container '${c.name}' has NET_ADMIN capability` });
          }

          if (pod.spec?.hostNetwork) podFindings.push({ severity: "CRITICAL", msg: "Pod uses hostNetwork" });
          if (pod.spec?.hostPID) podFindings.push({ severity: "CRITICAL", msg: "Pod uses hostPID" });
          if (pod.spec?.hostIPC) podFindings.push({ severity: "WARNING", msg: "Pod uses hostIPC" });

          if (podFindings.length > 0) {
            findings.push({ pod: pod.metadata.name, namespace: pod.metadata.namespace, issues: podFindings });
          }
        }

        const critical = findings.reduce((s, f) => s + f.issues.filter(i => i.severity === "CRITICAL").length, 0);
        const warning = findings.reduce((s, f) => s + f.issues.filter(i => i.severity === "WARNING").length, 0);
        const info = findings.reduce((s, f) => s + f.issues.filter(i => i.severity === "INFO").length, 0);

        const lines = [`Pod Security Audit${namespace ? ` (${namespace})` : ""} — ${pods.length} pod(s) scanned`,
          `${critical} critical, ${warning} warning, ${info} info findings\n`];

        for (const f of findings.slice(0, 40)) {
          lines.push(`${f.pod} (${f.namespace}):`);
          for (const i of f.issues) lines.push(`  [${i.severity}] ${i.msg}`);
        }
        if (findings.length === 0) lines.push("No security findings. All scanned pods follow security best practices.");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Pod security audit error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Network Policy Audit ----------
  server.tool(
    "security_network_policy_audit",
    "Identify pods and namespaces not covered by any NetworkPolicy",
    {
      namespace: z.string().optional().describe("Namespace to audit (omit for all namespaces)"),
    },
    async ({ namespace }) => {
      try {
        const npPath = namespace
          ? `/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies`
          : "/apis/networking.k8s.io/v1/networkpolicies";
        const podPath = namespace ? `/api/v1/namespaces/${namespace}/pods` : "/api/v1/pods";

        const [npData, podData] = await Promise.all([ocpGet(npPath), ocpGet(podPath)]);
        const policies = npData.items || [];
        const pods = (podData.items || []).filter(p => p.status?.phase === "Running");

        const nsByPolicy = {};
        for (const np of policies) {
          const ns = np.metadata.namespace;
          if (!nsByPolicy[ns]) nsByPolicy[ns] = [];
          nsByPolicy[ns].push({
            name: np.metadata.name,
            podSelector: np.spec?.podSelector?.matchLabels || {},
            hasIngress: (np.spec?.ingress || []).length > 0 || (np.spec?.policyTypes || []).includes("Ingress"),
            hasEgress: (np.spec?.egress || []).length > 0 || (np.spec?.policyTypes || []).includes("Egress"),
          });
        }

        const uncovered = [];
        const coveredNs = new Set();
        const allNs = new Set();

        for (const pod of pods.slice(0, 300)) {
          const ns = pod.metadata.namespace;
          allNs.add(ns);
          const nsPolices = nsByPolicy[ns] || [];
          if (nsPolices.length === 0) {
            uncovered.push({ pod: pod.metadata.name, namespace: ns, reason: "No NetworkPolicy in namespace" });
            continue;
          }
          coveredNs.add(ns);
          const podLabels = pod.metadata.labels || {};
          const matched = nsPolices.some(np => {
            const sel = np.podSelector;
            if (Object.keys(sel).length === 0) return true;
            return Object.entries(sel).every(([k, v]) => podLabels[k] === v);
          });
          if (!matched) {
            uncovered.push({ pod: pod.metadata.name, namespace: ns, reason: "Pod labels don't match any NetworkPolicy selector" });
          }
        }

        const nsWithoutPolicy = [...allNs].filter(ns => !nsByPolicy[ns]);

        const lines = [`Network Policy Audit${namespace ? ` (${namespace})` : ""}`,
          `${policies.length} NetworkPolicies across ${Object.keys(nsByPolicy).length} namespace(s)`,
          `${pods.length} running pods scanned\n`];

        if (nsWithoutPolicy.length > 0) {
          lines.push(`[CRITICAL] ${nsWithoutPolicy.length} namespace(s) with ZERO NetworkPolicies:`);
          nsWithoutPolicy.slice(0, 20).forEach(ns => lines.push(`  - ${ns}`));
          lines.push("");
        }
        if (uncovered.length > 0) {
          lines.push(`[WARNING] ${uncovered.length} uncovered pod(s):`);
          uncovered.slice(0, 30).forEach(u => lines.push(`  - ${u.pod} (${u.namespace}) — ${u.reason}`));
        }
        if (nsWithoutPolicy.length === 0 && uncovered.length === 0) {
          lines.push("[OK] All pods are covered by NetworkPolicies.");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Network policy audit error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Image Audit ----------
  server.tool(
    "security_image_audit",
    "Audit container images for :latest tags, untrusted registries, and missing digest pinning",
    {
      namespace: z.string().optional().describe("Namespace to audit (omit for all namespaces)"),
      allowedRegistries: z.array(z.string()).optional().describe("Trusted registry prefixes"),
    },
    async ({ namespace, allowedRegistries }) => {
      try {
        const trusted = allowedRegistries || [
          "registry.redhat.io", "quay.io", "registry.access.redhat.com",
          "image-registry.openshift-image-registry.svc", "ghcr.io", "docker.io/library",
        ];
        const path = namespace ? `/api/v1/namespaces/${namespace}/pods` : "/api/v1/pods";
        const data = await ocpGet(path);
        const pods = data.items || [];

        const findings = [];
        const imageSet = new Set();

        for (const pod of pods.slice(0, 300)) {
          const containers = [...(pod.spec?.containers || []), ...(pod.spec?.initContainers || [])];
          for (const c of containers) {
            const img = c.image || "";
            if (imageSet.has(img)) continue;
            imageSet.add(img);

            const issues = [];
            if (img.includes(":latest") || (!img.includes(":") && !img.includes("@sha256:"))) {
              issues.push("[WARNING] Uses :latest or no tag");
            }
            if (!img.includes("@sha256:")) {
              issues.push("[INFO] Not pinned to digest");
            }
            const isTrusted = trusted.some(r => img.startsWith(r) || img.includes(r));
            if (!isTrusted) {
              issues.push("[WARNING] Registry not in trusted list");
            }
            if (issues.length > 0) {
              findings.push({ image: img, pod: pod.metadata.name, namespace: pod.metadata.namespace, issues });
            }
          }
        }

        const lines = [`Image Audit${namespace ? ` (${namespace})` : ""} — ${imageSet.size} unique images scanned\n`];
        const warnings = findings.filter(f => f.issues.some(i => i.startsWith("[WARNING]")));
        lines.push(`${warnings.length} image(s) with warnings:\n`);

        for (const f of findings.slice(0, 40)) {
          lines.push(`${f.image}`);
          lines.push(`  Used by: ${f.pod} (${f.namespace})`);
          f.issues.forEach(i => lines.push(`  ${i}`));
        }
        if (findings.length === 0) lines.push("[OK] All images pass audit checks.");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Image audit error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Secret Audit ----------
  server.tool(
    "security_secret_audit",
    "Audit secrets: find orphaned secrets, old secrets, and default SA tokens",
    {
      namespace: z.string().describe("Namespace to audit"),
    },
    async ({ namespace }) => {
      try {
        const [secretData, podData] = await Promise.all([
          ocpGet(`/api/v1/namespaces/${namespace}/secrets`),
          ocpGet(`/api/v1/namespaces/${namespace}/pods`),
        ]);
        const secrets = secretData.items || [];
        const pods = podData.items || [];

        const referencedSecrets = new Set();
        for (const pod of pods) {
          for (const c of [...(pod.spec?.containers || []), ...(pod.spec?.initContainers || [])]) {
            for (const env of c.env || []) {
              if (env.valueFrom?.secretKeyRef?.name) referencedSecrets.add(env.valueFrom.secretKeyRef.name);
            }
            for (const src of c.envFrom || []) {
              if (src.secretRef?.name) referencedSecrets.add(src.secretRef.name);
            }
          }
          for (const vol of pod.spec?.volumes || []) {
            if (vol.secret?.secretName) referencedSecrets.add(vol.secret.secretName);
          }
          for (const ips of pod.spec?.imagePullSecrets || []) {
            if (ips.name) referencedSecrets.add(ips.name);
          }
        }

        const now = Date.now();
        const ninetyDays = 90 * 24 * 60 * 60 * 1000;
        const orphaned = [];
        const old = [];
        const saTokens = [];

        for (const s of secrets) {
          const name = s.metadata.name;
          const age = now - new Date(s.metadata.creationTimestamp).getTime();
          if (s.type === "kubernetes.io/service-account-token") {
            saTokens.push(name);
            continue;
          }
          if (!referencedSecrets.has(name)) orphaned.push(name);
          if (age > ninetyDays) old.push({ name, ageDays: Math.floor(age / 86400000) });
        }

        const lines = [`Secret Audit — namespace: ${namespace}`, `${secrets.length} secret(s) total\n`];
        if (orphaned.length > 0) {
          lines.push(`[WARNING] ${orphaned.length} orphaned secret(s) (not referenced by any pod):`);
          orphaned.slice(0, 20).forEach(s => lines.push(`  - ${s}`));
          lines.push("");
        }
        if (old.length > 0) {
          lines.push(`[INFO] ${old.length} secret(s) older than 90 days:`);
          old.slice(0, 20).forEach(s => lines.push(`  - ${s.name} (${s.ageDays} days old)`));
          lines.push("");
        }
        if (saTokens.length > 0) {
          lines.push(`[INFO] ${saTokens.length} ServiceAccount token secret(s) — consider token rotation`);
        }
        if (orphaned.length === 0 && old.length === 0) {
          lines.push("[OK] All secrets are referenced and within age policy.");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Secret audit error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Compliance Score ----------
  server.tool(
    "security_compliance_score",
    "Calculate an overall security posture score (0-100) with grade and recommendations",
    {
      namespace: z.string().optional().describe("Namespace to score (omit for cluster-wide sample)"),
    },
    async ({ namespace }) => {
      try {
        let score = 100;
        const deductions = [];
        const recommendations = [];

        const podPath = namespace ? `/api/v1/namespaces/${namespace}/pods` : "/api/v1/pods";
        const pods = (await ocpGet(podPath)).items || [];
        const runningPods = pods.filter(p => p.status?.phase === "Running").slice(0, 200);

        let privilegedCount = 0, noLimitsCount = 0, rootCount = 0, latestTagCount = 0;
        const imageSet = new Set();
        for (const pod of runningPods) {
          for (const c of pod.spec?.containers || []) {
            const sc = c.securityContext || {};
            if (sc.privileged) privilegedCount++;
            if (sc.runAsUser === 0 || pod.spec?.securityContext?.runAsUser === 0) rootCount++;
            if (!c.resources?.limits?.memory) noLimitsCount++;
            const img = c.image || "";
            imageSet.add(img);
            if (img.includes(":latest") || (!img.includes(":") && !img.includes("@"))) latestTagCount++;
          }
        }

        if (privilegedCount > 0) { const d = Math.min(20, privilegedCount * 5); score -= d; deductions.push(`-${d} pts: ${privilegedCount} privileged container(s)`); recommendations.push("Remove privileged mode from containers"); }
        if (rootCount > 0) { const d = Math.min(15, rootCount * 3); score -= d; deductions.push(`-${d} pts: ${rootCount} container(s) running as root`); recommendations.push("Set runAsNonRoot: true in securityContext"); }
        if (noLimitsCount > 0) { const d = Math.min(15, noLimitsCount * 2); score -= d; deductions.push(`-${d} pts: ${noLimitsCount} container(s) without memory limits`); recommendations.push("Set resource limits on all containers"); }
        if (latestTagCount > 0) { const d = Math.min(10, latestTagCount * 2); score -= d; deductions.push(`-${d} pts: ${latestTagCount} image(s) using :latest tag`); recommendations.push("Pin images to specific tags or digests"); }

        const npPath = namespace
          ? `/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies`
          : "/apis/networking.k8s.io/v1/networkpolicies";
        const npCount = ((await ocpGet(npPath).catch(() => ({ items: [] }))).items || []).length;
        if (npCount === 0) { score -= 15; deductions.push("-15 pts: No NetworkPolicies found"); recommendations.push("Create NetworkPolicies to restrict traffic"); }
        else if (namespace && npCount < 2) { score -= 5; deductions.push("-5 pts: Minimal NetworkPolicy coverage"); }

        try {
          const nodes = (await ocpGet("/api/v1/nodes")).items || [];
          const notReady = nodes.filter(n => !(n.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True"));
          if (notReady.length > 0) { score -= 10; deductions.push(`-10 pts: ${notReady.length} node(s) not ready`); recommendations.push("Investigate NotReady nodes"); }
        } catch {}

        try {
          const ops = (await ocpGet("/apis/config.openshift.io/v1/clusteroperators")).items || [];
          const degraded = ops.filter(o => (o.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True"));
          if (degraded.length > 0) { score -= 10; deductions.push(`-10 pts: ${degraded.length} degraded operator(s)`); recommendations.push(`Fix degraded operators: ${degraded.map(o => o.metadata.name).slice(0, 5).join(", ")}`); }
        } catch {}

        score = Math.max(0, score);
        const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";

        const lines = [
          `Security Compliance Score${namespace ? ` (${namespace})` : ""}`,
          `\n  Score: ${score}/100  Grade: ${grade}\n`,
          `Scanned: ${runningPods.length} pods, ${imageSet.size} images\n`,
        ];
        if (deductions.length > 0) {
          lines.push("Deductions:");
          deductions.forEach(d => lines.push(`  ${d}`));
          lines.push("");
        }
        if (recommendations.length > 0) {
          lines.push("Recommendations:");
          recommendations.forEach((r, i) => lines.push(`  ${i + 1}. ${r}`));
        }
        if (score === 100) lines.push("[OK] Perfect score — no security issues detected.");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Compliance score error: ${err.message}` }], isError: true };
      }
    }
  );
}
