/**
 * Vanilla Kubernetes Provider
 *
 * For upstream / self-managed Kubernetes clusters (kubeadm, k3s, kind,
 * minikube, Rancher RKE, etc.). Only uses standard K8s APIs.
 * Adds a few K8s-specific skills beyond what the base provider offers.
 * Inherits all shared K8s skills from base provider.
 */

import { SKILL_CATEGORIES, registerSkills } from "../skill-registry.js";
import { registerBaseSkills } from "./base.js";

function registerVanillaK8sSkills(apiGet) {
  registerBaseSkills(apiGet);

  const skills = [
    // ---- CLUSTER VERSION ----
    {
      id: "k8s-version",
      name: "Kubernetes Version",
      category: SKILL_CATEGORIES.UPGRADE,
      platforms: ["k8s"],
      intents: ["cluster_upgrade", "cluster_health"],
      keywords: ["version", "upgrade", "kubeadm", "kubernetes-version"],
      priority: 15,
      provider: "vanilla-k8s",
      description: "Show Kubernetes version and component versions",
      handler: async () => {
        const [version, nodes] = await Promise.all([
          apiGet("/version"),
          apiGet("/api/v1/nodes"),
        ]);
        const parts = [`### Kubernetes Version`, ""];
        parts.push(`**Server Version:** ${version?.gitVersion || "unknown"}`);
        parts.push(`**Platform:** ${version?.platform || "unknown"}`);
        parts.push(`**Go Version:** ${version?.goVersion || "?"}`);
        parts.push("");
        const versions = {};
        (nodes.items || []).forEach(n => {
          const v = n.status?.nodeInfo?.kubeletVersion || "?";
          versions[v] = (versions[v] || 0) + 1;
        });
        if (Object.keys(versions).length > 1) {
          parts.push(`[WARNING] **Mixed kubelet versions detected:**`);
          Object.entries(versions).forEach(([v, count]) => parts.push(`  - ${v}: ${count} node(s)`));
        } else {
          parts.push(`[OK] All nodes running: ${Object.keys(versions)[0] || "?"}`);
        }
        return parts.join("\n");
      },
    },

    // ---- CERT-MANAGER (common in vanilla K8s) ----
    {
      id: "k8s-cert-manager",
      name: "cert-manager Status",
      category: SKILL_CATEGORIES.SECURITY,
      platforms: ["k8s"],
      intents: ["certificate_expiry", "certlife"],
      keywords: ["cert-manager", "certificate", "issuer", "letsencrypt", "tls"],
      priority: 15,
      provider: "vanilla-k8s",
      description: "Check cert-manager installation and certificate status",
      handler: async () => {
        const [certs, issuers, clusterIssuers] = await Promise.all([
          apiGet("/apis/cert-manager.io/v1/certificates").catch(() => ({ items: [] })),
          apiGet("/apis/cert-manager.io/v1/issuers").catch(() => ({ items: [] })),
          apiGet("/apis/cert-manager.io/v1/clusterissuers").catch(() => ({ items: [] })),
        ]);
        const certItems = certs.items || [];
        const parts = [`### cert-manager Status`, ""];
        parts.push(`**Certificates:** ${certItems.length} | **Issuers:** ${(issuers.items || []).length} | **ClusterIssuers:** ${(clusterIssuers.items || []).length}`);
        if (certItems.length > 0) {
          parts.push("");
          parts.push(`| Certificate | Namespace | Ready | Expiry | Issuer |`);
          parts.push(`| --- | --- | --- | --- | --- |`);
          certItems.slice(0, 20).forEach(c => {
            const conds = c.status?.conditions || [];
            const ready = conds.find(cd => cd.type === "Ready");
            const isReady = ready?.status === "True";
            const expiry = c.status?.notAfter ? new Date(c.status.notAfter).toISOString().slice(0, 10) : "—";
            const issuer = c.spec?.issuerRef?.name || "—";
            parts.push(`| ${isReady ? "[OK]" : "[WARNING]"} \`${c.metadata.name}\` | ${c.metadata.namespace} | ${isReady ? "Yes" : "No"} | ${expiry} | ${issuer} |`);
          });
        } else {
          parts.push("");
          parts.push(`[WARNING] cert-manager not detected or no certificates found.`);
        }
        return parts.join("\n");
      },
    },

    // ---- INGRESS CONTROLLER DETECTION ----
    {
      id: "k8s-ingress-controller",
      name: "Ingress Controller Detection",
      category: SKILL_CATEGORIES.NETWORKING,
      platforms: ["k8s"],
      intents: ["services", "ingress"],
      keywords: ["ingress-controller", "nginx", "traefik", "haproxy", "contour"],
      priority: 15,
      provider: "vanilla-k8s",
      description: "Detect which ingress controller is running",
      handler: async () => {
        const controllers = {
          "NGINX Ingress": { ns: "ingress-nginx", label: "app.kubernetes.io/name=ingress-nginx" },
          "Traefik": { ns: "traefik", label: "app.kubernetes.io/name=traefik" },
          "Contour": { ns: "projectcontour", label: "app=contour" },
          "HAProxy": { ns: "haproxy-controller", label: "app=haproxy-ingress" },
        };
        const parts = [`### Ingress Controller Detection`, ""];
        let found = false;
        for (const [name, config] of Object.entries(controllers)) {
          try {
            const pods = await apiGet(`/api/v1/namespaces/${config.ns}/pods?labelSelector=${encodeURIComponent(config.label)}`);
            if ((pods.items || []).length > 0) {
              const running = (pods.items || []).filter(p => p.status?.phase === "Running").length;
              parts.push(`[OK] **${name}**: ${running} pod(s) running in \`${config.ns}\``);
              found = true;
            }
          } catch { /* not found */ }
        }
        // Also check all namespaces for common patterns
        if (!found) {
          try {
            const allPods = await apiGet("/api/v1/pods?limit=200");
            const ingressPods = (allPods.items || []).filter(p => {
              const name = p.metadata.name || "";
              return name.includes("ingress") || name.includes("traefik") || name.includes("nginx");
            });
            if (ingressPods.length > 0) {
              parts.push(`**Found ingress-related pods:**`);
              ingressPods.slice(0, 5).forEach(p => parts.push(`  - \`${p.metadata.name}\` (${p.metadata.namespace})`));
              found = true;
            }
          } catch { /* skip */ }
        }
        if (!found) {
          parts.push(`[WARNING] No standard ingress controller detected.`);
        }
        return parts.join("\n");
      },
    },

    // ---- CLUSTER AUTOSCALER ----
    {
      id: "k8s-cluster-autoscaler",
      name: "Cluster Autoscaler",
      category: SKILL_CATEGORIES.SCALING,
      platforms: ["k8s"],
      intents: ["machines", "capacity"],
      keywords: ["autoscaler", "cluster-autoscaler", "scale-node"],
      priority: 15,
      provider: "vanilla-k8s",
      description: "Check Cluster Autoscaler status and configuration",
      handler: async () => {
        const caPods = await apiGet("/api/v1/pods?labelSelector=app=cluster-autoscaler&limit=10").catch(() => ({ items: [] }));
        const parts = [`### Cluster Autoscaler`, ""];
        if ((caPods.items || []).length > 0) {
          const running = (caPods.items || []).filter(p => p.status?.phase === "Running").length;
          parts.push(`[OK] Cluster Autoscaler: ${running}/${caPods.items.length} pod(s) running`);
          try {
            const cms = await apiGet("/api/v1/namespaces/kube-system/configmaps/cluster-autoscaler-status").catch(() => null);
            if (cms?.data?.status) {
              parts.push("");
              parts.push(`**Status:** Available via configmap \`cluster-autoscaler-status\``);
            }
          } catch { /* skip */ }
        } else {
          parts.push(`[WARNING] Cluster Autoscaler not detected. Node scaling must be done manually.`);
        }
        return parts.join("\n");
      },
    },

    // ---- STORAGE PROVISIONER ----
    {
      id: "k8s-storage-provisioner",
      name: "Storage Provisioners",
      category: SKILL_CATEGORIES.STORAGE,
      platforms: ["k8s"],
      intents: ["storage"],
      keywords: ["provisioner", "csi", "storage-driver", "nfs", "local-path"],
      priority: 15,
      provider: "vanilla-k8s",
      description: "List CSI drivers and storage provisioners",
      handler: async () => {
        const [csiDrivers, scs] = await Promise.all([
          apiGet("/apis/storage.k8s.io/v1/csidrivers").catch(() => ({ items: [] })),
          apiGet("/apis/storage.k8s.io/v1/storageclasses"),
        ]);
        const parts = [`### Storage Provisioners`, ""];
        const csiItems = csiDrivers.items || [];
        parts.push(`**CSI Drivers:** ${csiItems.length}`);
        if (csiItems.length > 0) {
          csiItems.forEach(d => parts.push(`  - \`${d.metadata.name}\``));
        }
        parts.push("");
        parts.push(`**StorageClasses:** ${(scs.items || []).length}`);
        (scs.items || []).forEach(sc => {
          const isDefault = sc.metadata?.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true";
          parts.push(`  - ${isDefault ? "[OK] (default)" : ""} \`${sc.metadata.name}\` — provisioner: ${sc.provisioner}`);
        });
        return parts.join("\n");
      },
    },
  ];

  return registerSkills(skills);
}

export { registerVanillaK8sSkills };
