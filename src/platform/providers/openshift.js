/**
 * OpenShift Provider
 *
 * Wraps the existing OpenShift functionality as agentic skills.
 * When platform is OpenShift/ROSA/ARO, this provider delegates
 * to the existing ocpGet() and existing handlers — zero rewrites.
 *
 * Also registers OpenShift-exclusive skills (Routes, SCCs, MCP,
 * ClusterVersion, OAuth, BuildConfig, ImageStreams, etc.)
 */

import { SKILL_CATEGORIES, registerSkills } from "../skill-registry.js";
import { registerBaseSkills } from "./base.js";

function registerOpenShiftSkills(apiGet) {
  // Register all shared K8s base skills first
  registerBaseSkills(apiGet);

  const skills = [
    // ---- OPENSHIFT ROUTES ----
    {
      id: "ocp-routes",
      name: "OpenShift Routes",
      category: SKILL_CATEGORIES.NETWORKING,
      platforms: ["openshift", "rosa", "aro"],
      intents: ["services", "ingress"],
      keywords: ["route", "routes", "url", "hostname", "exposed"],
      priority: 20,
      provider: "openshift",
      description: "List OpenShift Routes with TLS and health status",
      handler: async (ctx) => {
        const ns = ctx?.namespace;
        const path = ns ? `/apis/route.openshift.io/v1/namespaces/${ns}/routes` : "/apis/route.openshift.io/v1/routes?limit=200";
        const routes = await apiGet(path);
        const items = routes.items || [];
        const parts = [`### OpenShift Routes — ${items.length}${ns ? ` in ${ns}` : ""}`, ""];
        parts.push(`| Route | Namespace | Host | TLS | Service | Port |`);
        parts.push(`| --- | --- | --- | --- | --- | --- |`);
        items.slice(0, 50).forEach(r => {
          const tls = r.spec?.tls ? "[OK] " + (r.spec.tls.termination || "edge") : "[WARNING] None";
          parts.push(`| \`${r.metadata.name}\` | ${r.metadata.namespace} | ${r.spec?.host || "—"} | ${tls} | ${r.spec?.to?.name || "—"} | ${r.spec?.port?.targetPort || "—"} |`);
        });
        return parts.join("\n");
      },
    },

    // ---- SCC ----
    {
      id: "ocp-scc",
      name: "Security Context Constraints",
      category: SKILL_CATEGORIES.SECURITY,
      platforms: ["openshift", "rosa", "aro"],
      intents: ["security", "podsecurity"],
      keywords: ["scc", "security-context", "privileged", "anyuid", "restricted"],
      priority: 20,
      provider: "openshift",
      description: "Audit SecurityContextConstraints and their assignments",
      handler: async () => {
        const sccs = await apiGet("/apis/security.openshift.io/v1/securitycontextconstraints");
        const items = sccs.items || [];
        const parts = [`### Security Context Constraints — ${items.length} SCCs`, ""];
        parts.push(`| SCC | Priority | Run As User | SELinux | Privileged | Volumes |`);
        parts.push(`| --- | --- | --- | --- | --- | --- |`);
        items.forEach(s => {
          const priv = s.allowPrivilegedContainer ? "[CRITICAL] Yes" : "[OK] No";
          const volumes = (s.volumes || []).includes("*") ? "All" : (s.volumes || []).length + " types";
          parts.push(`| \`${s.metadata.name}\` | ${s.priority || 0} | ${s.runAsUser?.type || "?"} | ${s.seLinuxContext?.type || "?"} | ${priv} | ${volumes} |`);
        });
        return parts.join("\n");
      },
    },

    // ---- CLUSTER VERSION / UPGRADE ----
    {
      id: "ocp-cluster-version",
      name: "OpenShift Cluster Version",
      category: SKILL_CATEGORIES.UPGRADE,
      platforms: ["openshift", "rosa", "aro"],
      intents: ["cluster_upgrade"],
      keywords: ["upgrade", "version", "clusterversion", "channel", "update"],
      priority: 20,
      provider: "openshift",
      description: "Show current cluster version, channel, and available updates",
      handler: async () => {
        const cv = await apiGet("/apis/config.openshift.io/v1/clusterversions/version");
        const current = cv.status?.desired?.version || "unknown";
        const channel = cv.spec?.channel || "unknown";
        const available = (cv.status?.availableUpdates || []).map(u => u.version);
        const conditions = cv.status?.conditions || [];
        const parts = [`### OpenShift Cluster Version`, ""];
        parts.push(`**Current:** ${current} | **Channel:** ${channel}`);
        parts.push("");
        conditions.forEach(c => {
          const icon = c.status === "True" && c.type === "Available" ? "[OK]" : c.status === "True" && c.type === "Progressing" ? "[WARNING]" : c.status === "True" && c.type === "Degraded" ? "[CRITICAL]" : "[OK]";
          parts.push(`${icon} **${c.type}:** ${c.message || c.status}`);
        });
        if (available.length > 0) {
          parts.push("");
          parts.push(`**Available Updates:** ${available.slice(0, 10).join(", ")}`);
        }
        return parts.join("\n");
      },
    },

    // ---- CLUSTER OPERATORS ----
    {
      id: "ocp-operators",
      name: "Cluster Operators",
      category: SKILL_CATEGORIES.CLUSTER_HEALTH,
      platforms: ["openshift", "rosa", "aro"],
      intents: ["operators", "cluster_health"],
      keywords: ["operator", "clusteroperator", "degraded", "olm"],
      priority: 20,
      provider: "openshift",
      description: "Check health of all OpenShift cluster operators",
      handler: async () => {
        const cos = await apiGet("/apis/config.openshift.io/v1/clusteroperators");
        const items = cos.items || [];
        const degraded = items.filter(o => (o.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True"));
        const progressing = items.filter(o => (o.status?.conditions || []).some(c => c.type === "Progressing" && c.status === "True"));
        const parts = [`### Cluster Operators — ${items.length} total`, ""];
        parts.push(`[OK] Available: ${items.length - degraded.length} | [CRITICAL] Degraded: ${degraded.length} | [WARNING] Progressing: ${progressing.length}`);
        if (degraded.length > 0) {
          parts.push("");
          parts.push(`**Degraded Operators:**`);
          degraded.forEach(o => {
            const msg = (o.status?.conditions || []).find(c => c.type === "Degraded")?.message || "";
            parts.push(`  - [CRITICAL] **${o.metadata.name}**: ${msg.substring(0, 120)}`);
          });
        }
        return parts.join("\n");
      },
    },

    // ---- OAUTH / IDENTITY ----
    {
      id: "ocp-identity",
      name: "OpenShift Identity & OAuth",
      category: SKILL_CATEGORIES.IDENTITY,
      platforms: ["openshift", "rosa", "aro"],
      intents: ["identity"],
      keywords: ["oauth", "identity", "ldap", "htpasswd", "identity-provider"],
      priority: 20,
      provider: "openshift",
      description: "Audit OAuth configuration and identity providers",
      handler: async () => {
        const [oauth, users, groups] = await Promise.all([
          apiGet("/apis/config.openshift.io/v1/oauths/cluster").catch(() => null),
          apiGet("/apis/user.openshift.io/v1/users").catch(() => ({ items: [] })),
          apiGet("/apis/user.openshift.io/v1/groups").catch(() => ({ items: [] })),
        ]);
        const parts = [`### Identity & Access Management`, ""];
        if (oauth) {
          const providers = oauth.spec?.identityProviders || [];
          parts.push(`**Identity Providers (${providers.length}):**`);
          providers.forEach(p => {
            const type = p.type || Object.keys(p).find(k => k !== "name" && k !== "mappingMethod" && k !== "type") || "unknown";
            parts.push(`  - [OK] **${p.name}** — ${type} (${p.mappingMethod || "claim"})`);
          });
          if (providers.length === 0) {
            parts.push(`  [WARNING] No identity providers — only kubeadmin can log in`);
          }
        }
        parts.push("");
        parts.push(`**Users:** ${(users.items || []).length} | **Groups:** ${(groups.items || []).length}`);
        return parts.join("\n");
      },
    },

    // ---- MACHINECONFIGPOOL ----
    {
      id: "ocp-mcp-drift",
      name: "MachineConfigPool Drift",
      category: SKILL_CATEGORIES.PLATFORM_SPECIFIC,
      platforms: ["openshift", "rosa", "aro"],
      intents: ["mcpdrift"],
      keywords: ["machineconfig", "mcp", "machine-config-pool", "rendering", "drift"],
      priority: 20,
      provider: "openshift",
      description: "Check MachineConfigPool status and drift",
      handler: async () => {
        const mcps = await apiGet("/apis/machineconfiguration.openshift.io/v1/machineconfigpools");
        const items = mcps.items || [];
        const parts = [`### MachineConfigPool Status`, ""];
        parts.push(`| Pool | Updated | Degraded | Machines | Config |`);
        parts.push(`| --- | --- | --- | --- | --- |`);
        items.forEach(p => {
          const conds = p.status?.conditions || [];
          const updated = conds.find(c => c.type === "Updated")?.status === "True" ? "[OK]" : "[WARNING]";
          const degraded = conds.find(c => c.type === "Degraded")?.status === "True" ? "[CRITICAL]" : "[OK]";
          parts.push(`| \`${p.metadata.name}\` | ${updated} | ${degraded} | ${p.status?.machineCount || 0} | \`${p.status?.configuration?.name || "—"}\` |`);
        });
        return parts.join("\n");
      },
    },

    // ---- MACHINESETS ----
    {
      id: "ocp-machinesets",
      name: "MachineSets",
      category: SKILL_CATEGORIES.SCALING,
      platforms: ["openshift", "rosa", "aro"],
      intents: ["machines"],
      keywords: ["machineset", "machine", "scale-node"],
      priority: 20,
      provider: "openshift",
      description: "List MachineSets with replica counts and status",
      handler: async () => {
        const ms = await apiGet("/apis/machine.openshift.io/v1beta1/machinesets?limit=50").catch(() => ({ items: [] }));
        const items = ms.items || [];
        const parts = [`### MachineSets — ${items.length}`, ""];
        if (items.length > 0) {
          parts.push(`| MachineSet | Namespace | Desired | Ready | Available |`);
          parts.push(`| --- | --- | --- | --- | --- |`);
          items.forEach(m => {
            const desired = m.spec?.replicas ?? 0;
            const ready = m.status?.readyReplicas ?? 0;
            const icon = ready >= desired ? "[OK]" : "[WARNING]";
            parts.push(`| ${icon} \`${m.metadata.name}\` | ${m.metadata.namespace} | ${desired} | ${ready} | ${m.status?.availableReplicas ?? 0} |`);
          });
        }
        return parts.join("\n");
      },
    },

    // ---- BUILDCONFIGS ----
    {
      id: "ocp-builds",
      name: "Build Configs",
      category: SKILL_CATEGORIES.PLATFORM_SPECIFIC,
      platforms: ["openshift", "rosa", "aro"],
      intents: ["builds"],
      keywords: ["build", "buildconfig", "s2i", "source-to-image"],
      priority: 20,
      provider: "openshift",
      description: "List BuildConfigs and recent build status",
      handler: async () => {
        const bcs = await apiGet("/apis/build.openshift.io/v1/buildconfigs?limit=50").catch(() => ({ items: [] }));
        const items = bcs.items || [];
        const parts = [`### BuildConfigs — ${items.length}`, ""];
        if (items.length > 0) {
          parts.push(`| BuildConfig | Namespace | Type | Last Version |`);
          parts.push(`| --- | --- | --- | --- |`);
          items.forEach(b => {
            const type = b.spec?.strategy?.type || "?";
            parts.push(`| \`${b.metadata.name}\` | ${b.metadata.namespace} | ${type} | ${b.status?.lastVersion || 0} |`);
          });
        } else {
          parts.push("No BuildConfigs found.");
        }
        return parts.join("\n");
      },
    },

    // ---- IMAGE STREAMS ----
    {
      id: "ocp-imagestreams",
      name: "Image Streams",
      category: SKILL_CATEGORIES.PLATFORM_SPECIFIC,
      platforms: ["openshift", "rosa", "aro"],
      intents: ["images"],
      keywords: ["imagestream", "image-stream", "is", "tag"],
      priority: 20,
      provider: "openshift",
      description: "List ImageStreams with tag information",
      handler: async () => {
        const is = await apiGet("/apis/image.openshift.io/v1/imagestreams?limit=50").catch(() => ({ items: [] }));
        const items = is.items || [];
        const parts = [`### Image Streams — ${items.length}`, ""];
        if (items.length > 0) {
          parts.push(`| ImageStream | Namespace | Tags |`);
          parts.push(`| --- | --- | --- |`);
          items.slice(0, 30).forEach(i => {
            const tags = (i.status?.tags || []).map(t => t.tag).join(", ");
            parts.push(`| \`${i.metadata.name}\` | ${i.metadata.namespace} | ${tags || "—"} |`);
          });
        }
        return parts.join("\n");
      },
    },

    // ---- COMPLIANCE OPERATOR ----
    {
      id: "ocp-compliance",
      name: "Compliance Operator",
      category: SKILL_CATEGORIES.SECURITY,
      platforms: ["openshift", "rosa", "aro"],
      intents: ["compliance", "hardening"],
      keywords: ["compliance", "scan", "cis", "benchmark", "stig"],
      priority: 20,
      provider: "openshift",
      description: "Check Compliance Operator scans and results",
      handler: async () => {
        const scans = await apiGet("/apis/compliance.openshift.io/v1alpha1/compliancescans").catch(() => ({ items: [] }));
        const suites = await apiGet("/apis/compliance.openshift.io/v1alpha1/compliancesuites").catch(() => ({ items: [] }));
        const parts = [`### Compliance Operator`, ""];
        const scanItems = scans.items || [];
        const suiteItems = suites.items || [];
        parts.push(`**Suites:** ${suiteItems.length} | **Scans:** ${scanItems.length}`);
        if (scanItems.length > 0) {
          parts.push("");
          scanItems.forEach(s => {
            const status = s.status?.phase || "Unknown";
            const icon = status === "DONE" ? "[OK]" : "[WARNING]";
            parts.push(`  ${icon} \`${s.metadata.name}\` — ${status} (${s.spec?.profile || "?"})`);
          });
        } else {
          parts.push("");
          parts.push(`[WARNING] Compliance Operator not installed or no scans configured.`);
        }
        return parts.join("\n");
      },
    },
  ];

  return registerSkills(skills);
}

export { registerOpenShiftSkills };
