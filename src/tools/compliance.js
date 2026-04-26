/**
 * Compliance Framework Mapping
 *
 * Maps cluster security posture against CIS Kubernetes Benchmark,
 * NIST 800-190, and OpenShift-specific hardening guidelines.
 * Generates actionable remediation commands for each failing control.
 */

import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

const CIS_CONTROLS = [
  {
    id: "5.1.1", section: "RBAC", title: "Cluster-admin role used only where required",
    check: async () => {
      const crbs = await ocpGet("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings");
      const adminBindings = (crbs.items || []).filter(
        (b) => b.roleRef.name === "cluster-admin" && (b.subjects || []).some((s) => s.kind !== "ServiceAccount" || !s.namespace?.startsWith("openshift-"))
      );
      return {
        pass: adminBindings.length === 0,
        detail: adminBindings.length > 0
          ? `${adminBindings.length} non-system cluster-admin binding(s): ${adminBindings.slice(0, 5).map((b) => b.metadata.name).join(", ")}`
          : "Only system accounts have cluster-admin",
        fix: "oc delete clusterrolebinding <name>",
      };
    },
  },
  {
    id: "5.1.3", section: "RBAC", title: "Minimize wildcard use in Roles and ClusterRoles",
    check: async () => {
      const roles = await ocpGet("/apis/rbac.authorization.k8s.io/v1/clusterroles");
      const wildcard = (roles.items || []).filter(
        (r) => !r.metadata.name.startsWith("system:") && (r.rules || []).some((rule) => (rule.resources || []).includes("*") && (rule.verbs || []).includes("*"))
      );
      return {
        pass: wildcard.length === 0,
        detail: wildcard.length > 0
          ? `${wildcard.length} role(s) with wildcard access: ${wildcard.slice(0, 5).map((r) => r.metadata.name).join(", ")}`
          : "No custom roles with full wildcard access",
        fix: "Review and scope down: oc edit clusterrole <name>",
      };
    },
  },
  {
    id: "5.2.2", section: "Pod Security", title: "Containers should not run as root",
    check: async () => {
      const pods = await ocpGet("/api/v1/pods");
      const rootPods = (pods.items || []).filter((p) => {
        if (p.metadata.namespace?.startsWith("openshift-") || p.metadata.namespace === "kube-system") return false;
        return (p.spec?.containers || []).some((c) => c.securityContext?.runAsUser === 0 || (p.spec?.securityContext?.runAsNonRoot !== true && !c.securityContext?.runAsNonRoot));
      });
      return {
        pass: rootPods.length === 0,
        detail: rootPods.length > 0
          ? `${rootPods.length} pod(s) may run as root: ${rootPods.slice(0, 5).map((p) => `${p.metadata.namespace}/${p.metadata.name}`).join(", ")}`
          : "All user pods enforce runAsNonRoot",
        fix: "Add to pod spec: securityContext: { runAsNonRoot: true }",
      };
    },
  },
  {
    id: "5.2.3", section: "Pod Security", title: "Containers should not use privileged mode",
    check: async () => {
      const pods = await ocpGet("/api/v1/pods");
      const priv = (pods.items || []).filter((p) => {
        if (p.metadata.namespace?.startsWith("openshift-") || p.metadata.namespace === "kube-system") return false;
        return (p.spec?.containers || []).some((c) => c.securityContext?.privileged === true);
      });
      return {
        pass: priv.length === 0,
        detail: priv.length > 0
          ? `${priv.length} privileged container(s): ${priv.slice(0, 5).map((p) => `${p.metadata.namespace}/${p.metadata.name}`).join(", ")}`
          : "No privileged containers in user namespaces",
        fix: "Remove securityContext.privileged or use restricted SCC",
      };
    },
  },
  {
    id: "5.2.6", section: "Pod Security", title: "Containers should drop all capabilities",
    check: async () => {
      const pods = await ocpGet("/api/v1/pods");
      const noDrop = (pods.items || []).filter((p) => {
        if (p.metadata.namespace?.startsWith("openshift-") || p.metadata.namespace === "kube-system") return false;
        return (p.spec?.containers || []).some((c) => {
          const drop = c.securityContext?.capabilities?.drop || [];
          return !drop.includes("ALL") && !drop.includes("all");
        });
      });
      return {
        pass: noDrop.length <= 5,
        detail: `${noDrop.length} pod(s) don't drop all capabilities`,
        fix: "Add: securityContext: { capabilities: { drop: ['ALL'] } }",
      };
    },
  },
  {
    id: "5.3.2", section: "Network", title: "All namespaces should have NetworkPolicies",
    check: async () => {
      const [ns, np] = await Promise.all([
        ocpGet("/api/v1/namespaces"),
        ocpGet("/apis/networking.k8s.io/v1/networkpolicies"),
      ]);
      const userNs = (ns.items || []).filter((n) => !n.metadata.name.startsWith("openshift-") && !n.metadata.name.startsWith("kube-") && n.metadata.name !== "default");
      const coveredNs = new Set((np.items || []).map((p) => p.metadata.namespace));
      const uncovered = userNs.filter((n) => !coveredNs.has(n.metadata.name));
      return {
        pass: uncovered.length === 0,
        detail: uncovered.length > 0
          ? `${uncovered.length} namespace(s) without NetworkPolicy: ${uncovered.slice(0, 5).map((n) => n.metadata.name).join(", ")}`
          : "All user namespaces have NetworkPolicies",
        fix: "Apply default-deny: oc apply -f default-deny-netpol.yaml -n <namespace>",
      };
    },
  },
  {
    id: "5.4.1", section: "Secrets", title: "Use Secrets as environment variables or volumes, not command args",
    check: async () => {
      const pods = await ocpGet("/api/v1/pods");
      const exposed = (pods.items || []).filter((p) => {
        if (p.metadata.namespace?.startsWith("openshift-")) return false;
        return (p.spec?.containers || []).some((c) =>
          (c.command || []).concat(c.args || []).some((a) => /password|secret|token|key/i.test(a))
        );
      });
      return {
        pass: exposed.length === 0,
        detail: exposed.length > 0
          ? `${exposed.length} pod(s) may have secrets in command args`
          : "No secrets detected in command arguments",
        fix: "Use env valueFrom secretKeyRef or volume mounts instead",
      };
    },
  },
  {
    id: "5.7.1", section: "Resources", title: "CPU and memory limits should be set",
    check: async () => {
      const pods = await ocpGet("/api/v1/pods");
      const noLimits = (pods.items || []).filter((p) => {
        if (p.metadata.namespace?.startsWith("openshift-") || p.metadata.namespace === "kube-system") return false;
        if (p.status?.phase !== "Running") return false;
        return (p.spec?.containers || []).some((c) => !c.resources?.limits?.memory || !c.resources?.limits?.cpu);
      });
      return {
        pass: noLimits.length <= 3,
        detail: `${noLimits.length} running pod(s) without CPU/memory limits`,
        fix: "Add resources.limits to container spec or apply LimitRange to namespace",
      };
    },
  },
  {
    id: "OCP.1", section: "OpenShift", title: "Default project should not be used for workloads",
    check: async () => {
      const pods = await ocpGet("/api/v1/namespaces/default/pods").catch(() => ({ items: [] }));
      const userPods = (pods.items || []).filter((p) => !p.metadata.name.startsWith("kubernetes"));
      return {
        pass: userPods.length === 0,
        detail: userPods.length > 0 ? `${userPods.length} workload pod(s) in default namespace` : "Default namespace is clean",
        fix: "Move workloads to dedicated namespaces",
      };
    },
  },
  {
    id: "OCP.2", section: "OpenShift", title: "kubeadmin user should be removed after setup",
    check: async () => {
      const secret = await ocpGet("/api/v1/namespaces/kube-system/secrets/kubeadmin").catch(() => null);
      return {
        pass: secret === null,
        detail: secret ? "kubeadmin secret still exists — remove after configuring identity provider" : "kubeadmin has been removed",
        fix: "oc delete secret kubeadmin -n kube-system",
      };
    },
  },
  {
    id: "OCP.3", section: "OpenShift", title: "OAuth identity provider should be configured",
    check: async () => {
      const oauth = await ocpGet("/apis/config.openshift.io/v1/oauths/cluster").catch(() => null);
      const providers = oauth?.spec?.identityProviders || [];
      return {
        pass: providers.length > 0,
        detail: providers.length > 0
          ? `${providers.length} identity provider(s) configured: ${providers.map((p) => p.name).join(", ")}`
          : "No identity providers configured — only kubeadmin can log in",
        fix: "oc edit oauth cluster — add LDAP, OIDC, or HTPasswd provider",
      };
    },
  },
  {
    id: "OCP.4", section: "OpenShift", title: "Cluster operators should not be degraded",
    check: async () => {
      const ops = await ocpGet("/apis/config.openshift.io/v1/clusteroperators").catch(() => ({ items: [] }));
      const degraded = (ops.items || []).filter((o) =>
        (o.status?.conditions || []).some((c) => c.type === "Degraded" && c.status === "True")
      );
      return {
        pass: degraded.length === 0,
        detail: degraded.length > 0
          ? `${degraded.length} degraded operator(s): ${degraded.map((o) => o.metadata.name).join(", ")}`
          : "All cluster operators healthy",
        fix: "oc describe clusteroperator <name> — check status conditions",
      };
    },
  },
];

export function registerComplianceTools(server) {
  server.tool(
    "compliance_check",
    "Run CIS Kubernetes Benchmark and OpenShift hardening checks against the cluster. Returns pass/fail with remediation commands for each control.",
    {
      framework: z.enum(["cis", "openshift", "all"]).optional().default("all").describe("Which framework to check"),
    },
    async ({ framework }) => {
      const controls = framework === "cis"
        ? CIS_CONTROLS.filter((c) => !c.id.startsWith("OCP"))
        : framework === "openshift"
          ? CIS_CONTROLS.filter((c) => c.id.startsWith("OCP"))
          : CIS_CONTROLS;

      const results = [];
      let passed = 0;
      let failed = 0;

      for (const ctrl of controls) {
        try {
          const result = await ctrl.check();
          results.push({ ...ctrl, result });
          if (result.pass) passed++;
          else failed++;
        } catch (err) {
          results.push({ ...ctrl, result: { pass: false, detail: `Check error: ${err.message}`, fix: "Manual review required" } });
          failed++;
        }
      }

      const score = Math.round((passed / (passed + failed)) * 100);
      const lines = [
        `### Compliance Report — ${framework === "all" ? "CIS + OpenShift" : framework.toUpperCase()}`,
        `Score: **${score}/100** (${passed} passed, ${failed} failed)`,
        "",
      ];

      const sections = {};
      for (const r of results) {
        if (!sections[r.section]) sections[r.section] = [];
        sections[r.section].push(r);
      }

      for (const [section, items] of Object.entries(sections)) {
        lines.push(`#### ${section}`);
        for (const item of items) {
          const icon = item.result.pass ? "[PASS]" : "[FAIL]";
          lines.push(`${icon} **${item.id}** — ${item.title}`);
          lines.push(`  ${item.result.detail}`);
          if (!item.result.pass) lines.push(`  Fix: \`${item.result.fix}\``);
        }
        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
