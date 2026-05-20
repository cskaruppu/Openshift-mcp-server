/**
 * Base Kubernetes Provider
 *
 * Shared skills that work on ALL Kubernetes distributions using
 * standard K8s APIs. Platform-specific providers extend this
 * and add/override skills for their platform.
 *
 * This is the "Shared K8s Agent" from the architecture — it provides
 * ~50 universal skills that every platform inherits.
 */

import { SKILL_CATEGORIES, registerSkills } from "../skill-registry.js";

function fmtCpu(raw) {
  if (!raw) return "0m";
  const s = String(raw);
  if (s.endsWith("n")) return (parseInt(s) / 1e6).toFixed(1) + "m";
  if (s.endsWith("m")) return s;
  return (parseFloat(s) * 1000).toFixed(0) + "m";
}

function fmtMem(raw) {
  if (!raw) return "0Mi";
  const s = String(raw);
  if (s.endsWith("Ki")) return (parseInt(s) / 1024).toFixed(0) + "Mi";
  if (s.endsWith("Mi")) return s;
  if (s.endsWith("Gi")) return (parseFloat(s) * 1024).toFixed(0) + "Mi";
  return (parseInt(s) / (1024 * 1024)).toFixed(0) + "Mi";
}

function parseCpuNano(v) {
  if (!v) return 0;
  const s = String(v);
  if (s.endsWith("n")) return parseInt(s);
  if (s.endsWith("m")) return parseInt(s) * 1e6;
  return parseFloat(s) * 1e9;
}

function parseMemBytes(v) {
  if (!v) return 0;
  const s = String(v);
  if (s.endsWith("Ki")) return parseInt(s) * 1024;
  if (s.endsWith("Mi")) return parseInt(s) * 1024 * 1024;
  if (s.endsWith("Gi")) return parseInt(s) * 1024 * 1024 * 1024;
  return parseInt(s);
}

function registerBaseSkills(apiGet) {
  const skills = [
    // ---- CLUSTER HEALTH ----
    {
      id: "k8s-node-health",
      name: "Node Health Check",
      category: SKILL_CATEGORIES.CLUSTER_HEALTH,
      platforms: ["*"],
      intents: ["nodes", "cluster_health"],
      keywords: ["node", "nodes", "worker", "control-plane", "master", "not-ready"],
      priority: 10,
      provider: "shared-k8s",
      description: "Check node status, conditions, and readiness across the cluster",
      handler: async () => {
        const [nodes, nodeMetrics] = await Promise.all([
          apiGet("/api/v1/nodes"),
          apiGet("/apis/metrics.k8s.io/v1beta1/nodes").catch(() => ({ items: [] })),
        ]);
        const items = nodes.items || [];
        const metrics = nodeMetrics.items || [];
        const parts = [`### Node Health — ${items.length} Nodes`, ""];
        parts.push(`| Status | Node | Role | Version | CPU | Memory | Conditions |`);
        parts.push(`| --- | --- | --- | --- | --- | --- | --- |`);
        items.forEach(n => {
          const ready = (n.status?.conditions || []).find(c => c.type === "Ready");
          const isReady = ready?.status === "True";
          const icon = isReady ? "[OK]" : "[CRITICAL]";
          const roles = Object.keys(n.metadata?.labels || {}).filter(l => l.startsWith("node-role.kubernetes.io/")).map(l => l.split("/")[1]).join(", ") || "worker";
          const ver = n.status?.nodeInfo?.kubeletVersion || "?";
          const metric = metrics.find(m => m.metadata.name === n.metadata.name);
          const cpu = metric ? fmtCpu(metric.usage?.cpu) : "—";
          const mem = metric ? fmtMem(metric.usage?.memory) : "—";
          const issues = (n.status?.conditions || []).filter(c => c.status === "True" && c.type !== "Ready").map(c => c.type);
          parts.push(`| ${icon} | \`${n.metadata.name}\` | ${roles} | ${ver} | ${cpu} | ${mem} | ${issues.length > 0 ? issues.join(", ") : "Healthy"} |`);
        });
        return parts.join("\n");
      },
    },

    {
      id: "k8s-pod-summary",
      name: "Pod Summary",
      category: SKILL_CATEGORIES.CLUSTER_HEALTH,
      platforms: ["*"],
      intents: ["pod_summary", "cluster_health"],
      keywords: ["pod", "pods", "running", "pending", "failed", "status"],
      priority: 10,
      provider: "shared-k8s",
      description: "Summary of all pods by phase across the cluster",
      handler: async () => {
        const pods = await apiGet("/api/v1/pods?limit=1000");
        const items = pods.items || [];
        const phases = {};
        items.forEach(p => {
          const phase = p.status?.phase || "Unknown";
          phases[phase] = (phases[phase] || 0) + 1;
        });
        const crashPods = items.filter(p => (p.status?.containerStatuses || []).some(cs => cs.state?.waiting?.reason === "CrashLoopBackOff"));
        const parts = [`### Pod Summary — ${items.length} Total`, ""];
        parts.push(`| Phase | Count |`);
        parts.push(`| --- | --- |`);
        Object.entries(phases).sort((a, b) => b[1] - a[1]).forEach(([phase, count]) => {
          const icon = phase === "Running" ? "[OK]" : phase === "Succeeded" ? "[OK]" : "[WARNING]";
          parts.push(`| ${icon} ${phase} | ${count} |`);
        });
        if (crashPods.length > 0) {
          parts.push("");
          parts.push(`[CRITICAL] **${crashPods.length} CrashLoopBackOff pod(s):**`);
          crashPods.slice(0, 10).forEach(p => parts.push(`  - \`${p.metadata.name}\` (${p.metadata.namespace})`));
        }
        return parts.join("\n");
      },
    },

    // ---- WORKLOADS ----
    {
      id: "k8s-deployments",
      name: "Deployment Status",
      category: SKILL_CATEGORIES.WORKLOADS,
      platforms: ["*"],
      intents: ["deployments"],
      keywords: ["deployment", "deploy", "replica", "rollout", "scale"],
      priority: 10,
      provider: "shared-k8s",
      description: "List deployments with replica status and health",
      handler: async (ctx) => {
        const ns = ctx?.namespace;
        const path = ns ? `/apis/apps/v1/namespaces/${ns}/deployments` : "/apis/apps/v1/deployments?limit=200";
        const deploys = await apiGet(path);
        const items = deploys.items || [];
        const parts = [`### Deployments — ${items.length} found${ns ? ` in ${ns}` : ""}`, ""];
        parts.push(`| Status | Deployment | Namespace | Ready | Up-to-date | Available |`);
        parts.push(`| --- | --- | --- | --- | --- | --- |`);
        items.slice(0, 50).forEach(d => {
          const ready = d.status?.readyReplicas || 0;
          const desired = d.spec?.replicas || 0;
          const icon = ready >= desired && desired > 0 ? "[OK]" : ready === 0 ? "[CRITICAL]" : "[WARNING]";
          parts.push(`| ${icon} | \`${d.metadata.name}\` | ${d.metadata.namespace} | ${ready}/${desired} | ${d.status?.updatedReplicas || 0} | ${d.status?.availableReplicas || 0} |`);
        });
        return parts.join("\n");
      },
    },

    // ---- RESOURCE METRICS ----
    {
      id: "k8s-pod-metrics",
      name: "Pod Resource Metrics",
      category: SKILL_CATEGORIES.OBSERVABILITY,
      platforms: ["*"],
      intents: ["metrics"],
      keywords: ["cpu", "memory", "top", "usage", "metrics", "consumption", "resource"],
      priority: 10,
      provider: "shared-k8s",
      description: "Show CPU and memory usage for pods from metrics API",
      handler: async (ctx) => {
        const ns = ctx?.namespace;
        const path = ns ? `/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods` : "/apis/metrics.k8s.io/v1beta1/pods?limit=200";
        const podMetrics = await apiGet(path);
        const items = podMetrics.items || [];
        const rows = items.map(p => {
          const containers = (p.containers || []);
          const cpuTotal = containers.reduce((s, c) => s + parseCpuNano(c.usage?.cpu), 0);
          const memTotal = containers.reduce((s, c) => s + parseMemBytes(c.usage?.memory), 0);
          return { name: p.metadata.name, ns: p.metadata.namespace, cpuTotal, memTotal };
        }).sort((a, b) => b.cpuTotal - a.cpuTotal);
        const parts = [`### Pod Metrics — Top ${Math.min(rows.length, 30)} by CPU${ns ? ` in ${ns}` : ""}`, ""];
        parts.push(`| Pod | Namespace | CPU | Memory |`);
        parts.push(`| --- | --- | --- | --- |`);
        rows.slice(0, 30).forEach(r => {
          parts.push(`| \`${r.name}\` | ${r.ns} | ${fmtCpu(String(r.cpuTotal) + "n")} | ${fmtMem(String(Math.round(r.memTotal / 1024)) + "Ki")} |`);
        });
        return parts.join("\n");
      },
    },

    // ---- EVENTS ----
    {
      id: "k8s-events",
      name: "Cluster Events",
      category: SKILL_CATEGORIES.OBSERVABILITY,
      platforms: ["*"],
      intents: ["events"],
      keywords: ["event", "events", "warning", "error"],
      priority: 10,
      provider: "shared-k8s",
      description: "Show recent warning events from the cluster",
      handler: async (ctx) => {
        const ns = ctx?.namespace;
        const path = ns
          ? `/api/v1/namespaces/${ns}/events?fieldSelector=type=Warning&limit=50`
          : "/api/v1/events?fieldSelector=type=Warning&limit=100";
        const events = await apiGet(path);
        const items = (events.items || []).sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0));
        const parts = [`### Warning Events — ${items.length} found${ns ? ` in ${ns}` : ""}`, ""];
        parts.push(`| Type | Reason | Object | Namespace | Message | Count |`);
        parts.push(`| --- | --- | --- | --- | --- | --- |`);
        items.slice(0, 30).forEach(e => {
          const msg = (e.message || "").substring(0, 80).replace(/\|/g, "/");
          parts.push(`| [WARNING] | **${e.reason}** | ${e.involvedObject?.kind}/${e.involvedObject?.name} | ${e.metadata?.namespace || "—"} | ${msg} | x${e.count || 1} |`);
        });
        return parts.join("\n");
      },
    },

    // ---- RBAC ----
    {
      id: "k8s-rbac-audit",
      name: "RBAC Audit",
      category: SKILL_CATEGORIES.SECURITY,
      platforms: ["*"],
      intents: ["rbac"],
      keywords: ["rbac", "role", "binding", "permission", "access", "clusterrole"],
      priority: 10,
      provider: "shared-k8s",
      description: "Audit cluster roles, bindings, and admin access",
      handler: async () => {
        const [crbs, crs] = await Promise.all([
          apiGet("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings"),
          apiGet("/apis/rbac.authorization.k8s.io/v1/clusterroles"),
        ]);
        const adminBindings = (crbs.items || []).filter(b => b.roleRef?.name === "cluster-admin");
        const parts = [`### RBAC Audit`, ""];
        parts.push(`**ClusterRoles:** ${(crs.items || []).length} | **ClusterRoleBindings:** ${(crbs.items || []).length}`);
        parts.push("");
        if (adminBindings.length > 0) {
          parts.push(`**cluster-admin bindings:**`);
          adminBindings.forEach(b => {
            (b.subjects || []).forEach(s => {
              parts.push(`  - [WARNING] **${s.kind}** \`${s.name}\`${s.namespace ? ` (${s.namespace})` : ""}`);
            });
          });
        }
        return parts.join("\n");
      },
    },

    // ---- SERVICES / NETWORKING ----
    {
      id: "k8s-services",
      name: "Service Status",
      category: SKILL_CATEGORIES.NETWORKING,
      platforms: ["*"],
      intents: ["services"],
      keywords: ["service", "endpoint", "loadbalancer", "clusterip"],
      priority: 5,
      provider: "shared-k8s",
      description: "List services with type, cluster IP, and ports",
      handler: async (ctx) => {
        const ns = ctx?.namespace;
        const path = ns ? `/api/v1/namespaces/${ns}/services` : "/api/v1/services?limit=200";
        const svcs = await apiGet(path);
        const items = (svcs.items || []).filter(s => !s.metadata.namespace?.startsWith("kube-"));
        const parts = [`### Services — ${items.length}${ns ? ` in ${ns}` : ""}`, ""];
        parts.push(`| Service | Namespace | Type | Cluster IP | Ports |`);
        parts.push(`| --- | --- | --- | --- | --- |`);
        items.slice(0, 40).forEach(s => {
          const ports = (s.spec?.ports || []).map(p => `${p.port}/${p.protocol}`).join(", ");
          parts.push(`| \`${s.metadata.name}\` | ${s.metadata.namespace} | ${s.spec?.type} | ${s.spec?.clusterIP || "—"} | ${ports} |`);
        });
        return parts.join("\n");
      },
    },

    // ---- INGRESS (standard K8s) ----
    {
      id: "k8s-ingress",
      name: "Ingress Status",
      category: SKILL_CATEGORIES.NETWORKING,
      platforms: ["*"],
      intents: ["services", "ingress"],
      keywords: ["ingress", "url", "host", "tls"],
      priority: 5,
      provider: "shared-k8s",
      description: "List K8s Ingress resources with hosts, paths, and TLS",
      handler: async () => {
        const ingresses = await apiGet("/apis/networking.k8s.io/v1/ingresses");
        const items = ingresses.items || [];
        const parts = [`### Ingress Resources — ${items.length}`, ""];
        if (items.length > 0) {
          parts.push(`| Ingress | Namespace | Hosts | TLS | Class |`);
          parts.push(`| --- | --- | --- | --- | --- |`);
          items.forEach(i => {
            const hosts = (i.spec?.rules || []).map(r => r.host || "*").join(", ");
            const tls = (i.spec?.tls || []).length > 0 ? "[OK] Yes" : "[WARNING] No";
            const cls = i.spec?.ingressClassName || i.metadata?.annotations?.["kubernetes.io/ingress.class"] || "default";
            parts.push(`| \`${i.metadata.name}\` | ${i.metadata.namespace} | ${hosts} | ${tls} | ${cls} |`);
          });
        } else {
          parts.push("No Ingress resources found.");
        }
        return parts.join("\n");
      },
    },

    // ---- HPA ----
    {
      id: "k8s-hpa",
      name: "HPA Status",
      category: SKILL_CATEGORIES.SCALING,
      platforms: ["*"],
      intents: ["hpa"],
      keywords: ["hpa", "autoscaler", "autoscaling", "scale"],
      priority: 10,
      provider: "shared-k8s",
      description: "Check HorizontalPodAutoscaler status and scaling",
      handler: async () => {
        const hpas = await apiGet("/apis/autoscaling/v2/horizontalpodautoscalers").catch(() =>
          apiGet("/apis/autoscaling/v1/horizontalpodautoscalers")
        );
        const items = hpas.items || [];
        const parts = [`### HPA Status — ${items.length} Autoscalers`, ""];
        if (items.length > 0) {
          parts.push(`| HPA | Namespace | Target | Min | Max | Current | Desired |`);
          parts.push(`| --- | --- | --- | --- | --- | --- | --- |`);
          items.forEach(h => {
            const current = h.status?.currentReplicas ?? "?";
            const max = h.spec?.maxReplicas ?? "?";
            const icon = current >= max ? "[WARNING]" : "[OK]";
            parts.push(`| ${icon} \`${h.metadata.name}\` | ${h.metadata.namespace} | ${h.spec?.scaleTargetRef?.name || "?"} | ${h.spec?.minReplicas ?? "?"} | ${max} | ${current} | ${h.status?.desiredReplicas ?? "?"} |`);
          });
        } else {
          parts.push("[WARNING] No HPAs found.");
        }
        return parts.join("\n");
      },
    },

    // ---- PDB ----
    {
      id: "k8s-pdb",
      name: "PDB Analysis",
      category: SKILL_CATEGORIES.WORKLOADS,
      platforms: ["*"],
      intents: ["pdb"],
      keywords: ["pdb", "disruption", "budget", "eviction", "drain"],
      priority: 10,
      provider: "shared-k8s",
      description: "Analyze PodDisruptionBudgets for upgrade/drain blockers",
      handler: async () => {
        const pdbs = await apiGet("/apis/policy/v1/poddisruptionbudgets");
        const items = pdbs.items || [];
        const parts = [`### PDB Analysis — ${items.length} PodDisruptionBudgets`, ""];
        if (items.length > 0) {
          parts.push(`| PDB | Namespace | Min Available | Max Unavailable | Healthy | Disruptions Allowed |`);
          parts.push(`| --- | --- | --- | --- | --- | --- |`);
          items.forEach(p => {
            const allowed = p.status?.disruptionsAllowed ?? "?";
            const icon = allowed === 0 ? "[CRITICAL]" : "[OK]";
            parts.push(`| ${icon} \`${p.metadata.name}\` | ${p.metadata.namespace} | ${p.spec?.minAvailable ?? "—"} | ${p.spec?.maxUnavailable ?? "—"} | ${p.status?.currentHealthy ?? "?"} | ${allowed} |`);
          });
        } else {
          parts.push("[WARNING] No PDBs found. Consider adding PDBs for critical workloads.");
        }
        return parts.join("\n");
      },
    },

    // ---- PROBES ----
    {
      id: "k8s-probes",
      name: "Health Probe Coverage",
      category: SKILL_CATEGORIES.WORKLOADS,
      platforms: ["*"],
      intents: ["probes"],
      keywords: ["probe", "liveness", "readiness", "startup", "health check"],
      priority: 10,
      provider: "shared-k8s",
      description: "Analyze liveness/readiness/startup probe coverage",
      handler: async () => {
        const pods = await apiGet("/api/v1/pods?fieldSelector=status.phase=Running&limit=500");
        const items = (pods.items || []).filter(p => !p.metadata.namespace?.startsWith("kube-"));
        let noLiveness = 0, noReadiness = 0, total = 0;
        const missing = [];
        items.forEach(p => {
          (p.spec?.containers || []).forEach(c => {
            total++;
            const m = [];
            if (!c.livenessProbe) { noLiveness++; m.push("liveness"); }
            if (!c.readinessProbe) { noReadiness++; m.push("readiness"); }
            if (m.length > 0) missing.push({ pod: p.metadata.name, ns: p.metadata.namespace, container: c.name, missing: m });
          });
        });
        const parts = [`### Health Probe Coverage — ${total} containers`, ""];
        parts.push(`| Probe | Missing | Coverage |`);
        parts.push(`| --- | --- | --- |`);
        parts.push(`| Liveness | ${noLiveness || "[OK] 0"} | ${total > 0 ? ((1 - noLiveness / total) * 100).toFixed(0) : 0}% |`);
        parts.push(`| Readiness | ${noReadiness || "[OK] 0"} | ${total > 0 ? ((1 - noReadiness / total) * 100).toFixed(0) : 0}% |`);
        if (missing.length > 0) {
          parts.push("");
          parts.push(`**Missing probes:**`);
          missing.slice(0, 15).forEach(m => parts.push(`  - [WARNING] \`${m.pod}\`/\`${m.container}\` (${m.ns}) — ${m.missing.join(", ")}`));
        }
        return parts.join("\n");
      },
    },

    // ---- CAPACITY ----
    {
      id: "k8s-capacity",
      name: "Capacity Planning",
      category: SKILL_CATEGORIES.CLUSTER_HEALTH,
      platforms: ["*"],
      intents: ["capacity", "saturation"],
      keywords: ["capacity", "headroom", "runway", "saturation", "pressure", "exhaustion"],
      priority: 10,
      provider: "shared-k8s",
      description: "Analyze cluster capacity, headroom, and resource pressure",
      handler: async () => {
        const [nodes, nodeMetrics, pods] = await Promise.all([
          apiGet("/api/v1/nodes"),
          apiGet("/apis/metrics.k8s.io/v1beta1/nodes").catch(() => ({ items: [] })),
          apiGet("/api/v1/pods?fieldSelector=status.phase=Running&limit=1000"),
        ]);
        let totalCpuAlloc = 0, totalMemAlloc = 0, totalCpuUsed = 0, totalMemUsed = 0, totalCpuReq = 0, totalMemReq = 0;
        (nodes.items || []).forEach(n => {
          totalCpuAlloc += parseCpuNano(n.status?.allocatable?.cpu || "0");
          totalMemAlloc += parseMemBytes(n.status?.allocatable?.memory || "0");
          const metric = (nodeMetrics.items || []).find(m => m.metadata.name === n.metadata.name);
          if (metric) {
            totalCpuUsed += parseCpuNano(metric.usage?.cpu || "0");
            totalMemUsed += parseMemBytes(metric.usage?.memory || "0");
          }
        });
        (pods.items || []).forEach(p => {
          (p.spec?.containers || []).forEach(c => {
            totalCpuReq += parseCpuNano(c.resources?.requests?.cpu || "0");
            totalMemReq += parseMemBytes(c.resources?.requests?.memory || "0");
          });
        });
        const cpuReqPct = totalCpuAlloc > 0 ? ((totalCpuReq / totalCpuAlloc) * 100).toFixed(1) : "?";
        const memReqPct = totalMemAlloc > 0 ? ((totalMemReq / totalMemAlloc) * 100).toFixed(1) : "?";
        const parts = [`### Capacity Planning — ${(nodes.items || []).length} nodes`, ""];
        parts.push(`| Resource | Allocatable | Requested | Used | Req% | Headroom |`);
        parts.push(`| --- | --- | --- | --- | --- | --- |`);
        parts.push(`| CPU | ${fmtCpu(String(totalCpuAlloc) + "n")} | ${fmtCpu(String(totalCpuReq) + "n")} | ${fmtCpu(String(totalCpuUsed) + "n")} | ${cpuReqPct}% | ${(100 - parseFloat(cpuReqPct)).toFixed(1)}% |`);
        parts.push(`| Memory | ${fmtMem(String(Math.round(totalMemAlloc / 1024)) + "Ki")} | ${fmtMem(String(Math.round(totalMemReq / 1024)) + "Ki")} | ${fmtMem(String(Math.round(totalMemUsed / 1024)) + "Ki")} | ${memReqPct}% | ${(100 - parseFloat(memReqPct)).toFixed(1)}% |`);
        return parts.join("\n");
      },
    },

    // ---- INCIDENT ----
    {
      id: "k8s-incident",
      name: "Active Incident Detection",
      category: SKILL_CATEGORIES.INCIDENT,
      platforms: ["*"],
      intents: ["incident", "impact"],
      keywords: ["incident", "outage", "blast radius", "impact", "affected"],
      priority: 10,
      provider: "shared-k8s",
      description: "Detect active incidents from cluster signals",
      handler: async () => {
        const [events, nodes, pods] = await Promise.all([
          apiGet("/api/v1/events?fieldSelector=type=Warning&limit=200"),
          apiGet("/api/v1/nodes"),
          apiGet("/api/v1/pods?limit=500"),
        ]);
        const notReady = (nodes.items || []).filter(n => {
          const r = (n.status?.conditions || []).find(c => c.type === "Ready");
          return !r || r.status !== "True";
        });
        const crashPods = (pods.items || []).filter(p => (p.status?.containerStatuses || []).some(cs => cs.state?.waiting?.reason === "CrashLoopBackOff"));
        const pending = (pods.items || []).filter(p => p.status?.phase === "Pending");
        const severity = (notReady.length > 0 || crashPods.length > 10) ? "[CRITICAL]" : (crashPods.length > 0 || pending.length > 5) ? "[WARNING]" : "[OK]";
        const parts = [`### Active Incident Summary`, ""];
        parts.push(`**Cluster Severity:** ${severity}`);
        parts.push("");
        parts.push(`| Signal | Count | Status |`);
        parts.push(`| --- | --- | --- |`);
        parts.push(`| NotReady Nodes | ${notReady.length} | ${notReady.length > 0 ? "[CRITICAL]" : "[OK]"} |`);
        parts.push(`| CrashLoopBackOff Pods | ${crashPods.length} | ${crashPods.length > 0 ? "[WARNING]" : "[OK]"} |`);
        parts.push(`| Pending Pods | ${pending.length} | ${pending.length > 5 ? "[WARNING]" : "[OK]"} |`);
        parts.push(`| Warning Events | ${(events.items || []).length} | ${(events.items || []).length > 50 ? "[WARNING]" : "[OK]"} |`);
        return parts.join("\n");
      },
    },

    // ---- GOVERNANCE ----
    {
      id: "k8s-governance",
      name: "Tenant Governance",
      category: SKILL_CATEGORIES.GOVERNANCE,
      platforms: ["*"],
      intents: ["governance"],
      keywords: ["quota", "limitrange", "tenant", "governance", "chargeback"],
      priority: 10,
      provider: "shared-k8s",
      description: "Audit resource quotas, limit ranges, and namespace governance",
      handler: async () => {
        const [quotas, limitRanges, namespaces] = await Promise.all([
          apiGet("/api/v1/resourcequotas"),
          apiGet("/api/v1/limitranges"),
          apiGet("/api/v1/namespaces"),
        ]);
        const nsItems = (namespaces.items || []).filter(n => !n.metadata.name.startsWith("kube-") && n.metadata.name !== "default");
        const nsWithQuota = new Set((quotas.items || []).map(q => q.metadata.namespace));
        const nsWithoutQuota = nsItems.filter(n => !nsWithQuota.has(n.metadata.name));
        const parts = [`### Tenant Governance`, ""];
        parts.push(`**Namespaces:** ${nsItems.length} | **With Quotas:** ${nsWithQuota.size} | **With LimitRanges:** ${(limitRanges.items || []).length}`);
        if (nsWithoutQuota.length > 0) {
          parts.push("");
          parts.push(`[WARNING] **${nsWithoutQuota.length} namespace(s) without ResourceQuota:**`);
          nsWithoutQuota.slice(0, 10).forEach(n => parts.push(`  - \`${n.metadata.name}\``));
        }
        return parts.join("\n");
      },
    },

    // ---- NETWORK POLICIES ----
    {
      id: "k8s-network-policies",
      name: "Network Policy Audit",
      category: SKILL_CATEGORIES.NETWORKING,
      platforms: ["*"],
      intents: ["network"],
      keywords: ["network", "policy", "egress", "network-policy"],
      priority: 5,
      provider: "shared-k8s",
      description: "Audit network policy coverage across namespaces",
      handler: async () => {
        const [nps, namespaces] = await Promise.all([
          apiGet("/apis/networking.k8s.io/v1/networkpolicies"),
          apiGet("/api/v1/namespaces"),
        ]);
        const nsItems = (namespaces.items || []).filter(n => !n.metadata.name.startsWith("kube-") && n.metadata.name !== "default");
        const npNs = new Set((nps.items || []).map(np => np.metadata.namespace));
        const unprotected = nsItems.filter(n => !npNs.has(n.metadata.name));
        const parts = [`### Network Policy Audit`, ""];
        parts.push(`**Policies:** ${(nps.items || []).length} | **Namespaces with policies:** ${npNs.size}/${nsItems.length}`);
        if (unprotected.length > 0) {
          parts.push("");
          parts.push(`[WARNING] **${unprotected.length} namespace(s) without NetworkPolicy:**`);
          unprotected.slice(0, 10).forEach(n => parts.push(`  - \`${n.metadata.name}\``));
        }
        return parts.join("\n");
      },
    },

    // ---- PSA (Pod Security Admission) ----
    {
      id: "k8s-pod-security",
      name: "Pod Security Admission",
      category: SKILL_CATEGORIES.SECURITY,
      platforms: ["*"],
      intents: ["podsecurity"],
      keywords: ["psa", "pod-security", "restricted", "baseline", "privileged"],
      priority: 10,
      provider: "shared-k8s",
      description: "Audit Pod Security Admission labels across namespaces",
      handler: async () => {
        const namespaces = await apiGet("/api/v1/namespaces");
        const nsItems = (namespaces.items || []).filter(n => !n.metadata.name.startsWith("kube-") && n.metadata.name !== "default");
        let noLabels = 0;
        const parts = [`### Pod Security Admission`, ""];
        parts.push(`| Namespace | Enforce | Audit | Warn |`);
        parts.push(`| --- | --- | --- | --- |`);
        nsItems.forEach(n => {
          const labels = n.metadata.labels || {};
          const enforce = labels["pod-security.kubernetes.io/enforce"] || "—";
          const audit = labels["pod-security.kubernetes.io/audit"] || "—";
          const warn = labels["pod-security.kubernetes.io/warn"] || "—";
          if (enforce === "—" && audit === "—" && warn === "—") { noLabels++; return; }
          parts.push(`| \`${n.metadata.name}\` | ${enforce} | ${audit} | ${warn} |`);
        });
        if (noLabels > 0) {
          parts.push("");
          parts.push(`[WARNING] **${noLabels} namespace(s) have no PSA labels** — running with default security`);
        }
        return parts.join("\n");
      },
    },

    // ---- ORPHANED RESOURCES ----
    {
      id: "k8s-orphaned",
      name: "Orphaned Resource Detection",
      category: SKILL_CATEGORIES.GOVERNANCE,
      platforms: ["*"],
      intents: ["orphaned"],
      keywords: ["orphan", "unused", "dangling", "cleanup", "stale"],
      priority: 10,
      provider: "shared-k8s",
      description: "Detect potentially unused ConfigMaps, Secrets, PVCs",
      handler: async () => {
        const [pods, pvcs] = await Promise.all([
          apiGet("/api/v1/pods?limit=500"),
          apiGet("/api/v1/persistentvolumeclaims"),
        ]);
        const unboundPVCs = (pvcs.items || []).filter(p => p.status?.phase !== "Bound");
        const parts = [`### Orphaned Resource Detection`, ""];
        parts.push(`| Resource Type | Potentially Unused | Status |`);
        parts.push(`| --- | --- | --- |`);
        parts.push(`| Unbound PVCs | ${unboundPVCs.length} | ${unboundPVCs.length > 0 ? "[WARNING]" : "[OK]"} |`);
        if (unboundPVCs.length > 0) {
          parts.push("");
          unboundPVCs.slice(0, 10).forEach(p => parts.push(`  - [WARNING] \`${p.metadata.name}\` (${p.metadata.namespace}) — ${p.status?.phase}`));
        }
        return parts.join("\n");
      },
    },

    // ---- SUPPLY CHAIN ----
    {
      id: "k8s-supply-chain",
      name: "Supply Chain Security",
      category: SKILL_CATEGORIES.SUPPLY_CHAIN,
      platforms: ["*"],
      intents: ["supplychain", "imagestale"],
      keywords: ["sbom", "provenance", "unsigned", "supply-chain", "image", "stale"],
      priority: 10,
      provider: "shared-k8s",
      description: "Assess container image provenance and staleness",
      handler: async () => {
        const pods = await apiGet("/api/v1/pods?limit=500");
        const images = new Set();
        (pods.items || []).forEach(p => {
          (p.spec?.containers || []).forEach(c => images.add(c.image));
        });
        const unsigned = [...images].filter(img => !img.includes("@sha256:"));
        const parts = [`### Supply Chain Security`, ""];
        parts.push(`**Unique Images:** ${images.size} | **Tag-only (no digest):** ${unsigned.length > 0 ? `[WARNING] ${unsigned.length}` : "[OK] 0"}`);
        if (unsigned.length > 0) {
          parts.push("");
          unsigned.slice(0, 15).forEach(img => parts.push(`  - [WARNING] \`${img}\``));
        }
        return parts.join("\n");
      },
    },

    // ---- TOPOLOGY ----
    {
      id: "k8s-topology",
      name: "Topology & Scheduling",
      category: SKILL_CATEGORIES.WORKLOADS,
      platforms: ["*"],
      intents: ["topology"],
      keywords: ["topology", "affinity", "zone", "spread", "scheduling"],
      priority: 10,
      provider: "shared-k8s",
      description: "Analyze zone spread, affinity rules, and scheduling constraints",
      handler: async () => {
        const nodes = await apiGet("/api/v1/nodes");
        const zones = {};
        (nodes.items || []).forEach(n => {
          const zone = n.metadata.labels?.["topology.kubernetes.io/zone"] || "unknown";
          zones[zone] = (zones[zone] || 0) + 1;
        });
        const parts = [`### Topology & Scheduling`, ""];
        parts.push(`**Nodes:** ${(nodes.items || []).length} | **Zones:** ${Object.keys(zones).length}`);
        parts.push("");
        parts.push(`| Zone | Nodes |`);
        parts.push(`| --- | --- |`);
        Object.entries(zones).forEach(([z, c]) => parts.push(`| ${z} | ${c} |`));
        if (Object.keys(zones).length < 2) {
          parts.push("");
          parts.push(`[WARNING] Single-zone deployment — consider multi-zone for HA`);
        }
        return parts.join("\n");
      },
    },

    // ---- WEBHOOKS ----
    {
      id: "k8s-webhooks",
      name: "Admission Webhooks",
      category: SKILL_CATEGORIES.SECURITY,
      platforms: ["*"],
      intents: ["webhook"],
      keywords: ["webhook", "admission", "validating", "mutating"],
      priority: 10,
      provider: "shared-k8s",
      description: "Audit admission webhook configurations and failure policies",
      handler: async () => {
        const [validating, mutating] = await Promise.all([
          apiGet("/apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations"),
          apiGet("/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations"),
        ]);
        const vCount = (validating.items || []).length;
        const mCount = (mutating.items || []).length;
        const failClosed = [...(validating.items || []), ...(mutating.items || [])].filter(c => (c.webhooks || []).some(w => w.failurePolicy === "Fail"));
        const parts = [`### Admission Webhooks`, ""];
        parts.push(`**Validating:** ${vCount} | **Mutating:** ${mCount}`);
        if (failClosed.length > 0) {
          parts.push("");
          parts.push(`[WARNING] **${failClosed.length} webhook(s) with failurePolicy=Fail**`);
        }
        return parts.join("\n");
      },
    },

    // ---- STORAGE ----
    {
      id: "k8s-storage",
      name: "Storage Health",
      category: SKILL_CATEGORIES.STORAGE,
      platforms: ["*"],
      intents: ["storage"],
      keywords: ["pvc", "pv", "storage", "storageclass", "persistent"],
      priority: 10,
      provider: "shared-k8s",
      description: "Check PVC status, storage classes, and persistent volumes",
      handler: async () => {
        const [pvcs, pvs, scs] = await Promise.all([
          apiGet("/api/v1/persistentvolumeclaims"),
          apiGet("/api/v1/persistentvolumes"),
          apiGet("/apis/storage.k8s.io/v1/storageclasses"),
        ]);
        const parts = [`### Storage Health`, ""];
        parts.push(`**PVCs:** ${(pvcs.items || []).length} | **PVs:** ${(pvs.items || []).length} | **StorageClasses:** ${(scs.items || []).length}`);
        const pending = (pvcs.items || []).filter(p => p.status?.phase === "Pending");
        const lost = (pvcs.items || []).filter(p => p.status?.phase === "Lost");
        if (pending.length > 0 || lost.length > 0) {
          parts.push("");
          if (pending.length > 0) parts.push(`[WARNING] **${pending.length} Pending PVC(s)**`);
          if (lost.length > 0) parts.push(`[CRITICAL] **${lost.length} Lost PVC(s)**`);
        }
        return parts.join("\n");
      },
    },

    // ---- DEPRECATED APIs ----
    {
      id: "k8s-deprecated",
      name: "Deprecated API Detection",
      category: SKILL_CATEGORIES.GOVERNANCE,
      platforms: ["*"],
      intents: ["deprecated"],
      keywords: ["deprecated", "removed", "api-lifecycle", "api-version"],
      priority: 10,
      provider: "shared-k8s",
      description: "Detect usage of deprecated Kubernetes APIs",
      handler: async () => {
        const events = await apiGet("/api/v1/events?limit=500");
        const deprecation = (events.items || []).filter(e => (e.message || "").toLowerCase().includes("deprecated"));
        const parts = [`### Deprecated API Detection`, ""];
        if (deprecation.length > 0) {
          parts.push(`[WARNING] **${deprecation.length} deprecation events found**`);
          parts.push("");
          deprecation.slice(0, 15).forEach(e => {
            parts.push(`  - **${e.reason}**: ${(e.message || "").substring(0, 100)}`);
          });
        } else {
          parts.push(`[OK] No deprecation warnings in recent events.`);
        }
        return parts.join("\n");
      },
    },
  ];

  return registerSkills(skills);
}

export { registerBaseSkills, fmtCpu, fmtMem, parseCpuNano, parseMemBytes };
