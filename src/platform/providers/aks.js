/**
 * Azure AKS Provider
 *
 * AKS-specific agentic skills: AGIC Ingress, AAD Pod Identity,
 * Workload Identity, VMSS node pools, ACR integration, AKS extensions.
 * Inherits all shared K8s skills from base provider.
 */

import { SKILL_CATEGORIES, registerSkills } from "../skill-registry.js";
import { registerBaseSkills } from "./base.js";

function registerAKSSkills(apiGet) {
  registerBaseSkills(apiGet);

  const skills = [
    // ---- AGIC INGRESS ----
    {
      id: "aks-agic-ingress",
      name: "Azure Application Gateway Ingress",
      category: SKILL_CATEGORIES.NETWORKING,
      platforms: ["aks"],
      intents: ["services", "ingress"],
      keywords: ["agic", "app-gateway", "application-gateway", "ingress", "azure-lb"],
      priority: 20,
      provider: "aks",
      description: "Analyze AGIC-managed Ingress resources and backend pools",
      handler: async () => {
        const ingresses = await apiGet("/apis/networking.k8s.io/v1/ingresses");
        const items = ingresses.items || [];
        const agicIngresses = items.filter(i => {
          const cls = i.spec?.ingressClassName || i.metadata?.annotations?.["kubernetes.io/ingress.class"] || "";
          return cls === "azure-application-gateway" || cls === "azure/application-gateway" || i.metadata?.annotations?.["appgw.ingress.kubernetes.io/backend-path-prefix"];
        });
        const parts = [`### Azure Application Gateway Ingress`, ""];
        parts.push(`**Total Ingresses:** ${items.length} | **AGIC-managed:** ${agicIngresses.length}`);
        if (agicIngresses.length > 0) {
          parts.push("");
          parts.push(`| Ingress | Namespace | Host | Backend Protocol | WAF |`);
          parts.push(`| --- | --- | --- | --- | --- |`);
          agicIngresses.forEach(i => {
            const ann = i.metadata?.annotations || {};
            const protocol = ann["appgw.ingress.kubernetes.io/backend-protocol"] || "HTTP";
            const waf = ann["appgw.ingress.kubernetes.io/waf-policy-for-path"] ? "[OK] Enabled" : "—";
            const hosts = (i.spec?.rules || []).map(r => r.host || "*").join(", ");
            parts.push(`| \`${i.metadata.name}\` | ${i.metadata.namespace} | ${hosts} | ${protocol} | ${waf} |`);
          });
        }
        return parts.join("\n");
      },
    },

    // ---- AAD POD IDENTITY / WORKLOAD IDENTITY ----
    {
      id: "aks-workload-identity",
      name: "Azure Workload Identity",
      category: SKILL_CATEGORIES.IDENTITY,
      platforms: ["aks"],
      intents: ["identity", "rbac"],
      keywords: ["aad", "azure-ad", "workload-identity", "managed-identity", "pod-identity"],
      priority: 20,
      provider: "aks",
      description: "Audit Azure AD Workload Identity and Pod Identity bindings",
      handler: async () => {
        // Check for modern Workload Identity (federated)
        const sas = await apiGet("/api/v1/serviceaccounts?limit=500");
        const wiSAs = (sas.items || []).filter(sa => {
          const ann = sa.metadata?.annotations || {};
          return ann["azure.workload.identity/client-id"] || ann["azure.workload.identity/tenant-id"];
        });

        // Check for legacy AAD Pod Identity
        const azIdentities = await apiGet("/apis/aadpodidentity.k8s.io/v1/azureidentities").catch(() => ({ items: [] }));
        const azBindings = await apiGet("/apis/aadpodidentity.k8s.io/v1/azureidentitybindings").catch(() => ({ items: [] }));

        const parts = [`### Azure Identity & Workload Identity`, ""];

        if (wiSAs.length > 0) {
          parts.push(`**Workload Identity ServiceAccounts:** ${wiSAs.length}`);
          parts.push(`| ServiceAccount | Namespace | Client ID |`);
          parts.push(`| --- | --- | --- |`);
          wiSAs.forEach(sa => {
            const clientId = sa.metadata.annotations["azure.workload.identity/client-id"] || "—";
            parts.push(`| \`${sa.metadata.name}\` | ${sa.metadata.namespace} | \`${clientId}\` |`);
          });
          parts.push("");
        }

        if ((azIdentities.items || []).length > 0) {
          parts.push(`**Legacy AAD Pod Identity:**`);
          parts.push(`  - AzureIdentities: ${azIdentities.items.length}`);
          parts.push(`  - AzureIdentityBindings: ${(azBindings.items || []).length}`);
          parts.push(`  [WARNING] AAD Pod Identity is deprecated — migrate to Workload Identity`);
        }

        if (wiSAs.length === 0 && (azIdentities.items || []).length === 0) {
          parts.push(`[WARNING] No Azure identity bindings found. Pods may be using node-level managed identity.`);
        }
        return parts.join("\n");
      },
    },

    // ---- AKS NODE POOLS (from node labels) ----
    {
      id: "aks-nodepools",
      name: "AKS Node Pools",
      category: SKILL_CATEGORIES.SCALING,
      platforms: ["aks"],
      intents: ["machines", "capacity"],
      keywords: ["nodepool", "vmss", "agentpool", "node-pool", "scale-node"],
      priority: 20,
      provider: "aks",
      description: "Analyze AKS node pools from node labels (agent pool, VM size, zones)",
      handler: async () => {
        const nodes = await apiGet("/api/v1/nodes");
        const pools = {};
        (nodes.items || []).forEach(n => {
          const labels = n.metadata?.labels || {};
          const pool = labels["kubernetes.azure.com/agentpool"] || labels["agentpool"] || "default";
          const vmSize = labels["node.kubernetes.io/instance-type"] || labels["beta.kubernetes.io/instance-type"] || "?";
          const zone = labels["topology.kubernetes.io/zone"] || "?";
          const mode = labels["kubernetes.azure.com/mode"] || "User";
          if (!pools[pool]) pools[pool] = { count: 0, vmSizes: new Set(), zones: new Set(), ready: 0, mode };
          pools[pool].count++;
          pools[pool].vmSizes.add(vmSize);
          pools[pool].zones.add(zone);
          const ready = (n.status?.conditions || []).find(c => c.type === "Ready");
          if (ready?.status === "True") pools[pool].ready++;
        });
        const parts = [`### AKS Node Pools`, ""];
        parts.push(`| Pool | Mode | Nodes | Ready | VM Size(s) | Zones |`);
        parts.push(`| --- | --- | --- | --- | --- | --- |`);
        Object.entries(pools).forEach(([pool, data]) => {
          const icon = data.ready === data.count ? "[OK]" : "[WARNING]";
          parts.push(`| ${icon} \`${pool}\` | ${data.mode} | ${data.count} | ${data.ready} | ${[...data.vmSizes].join(", ")} | ${[...data.zones].join(", ")} |`);
        });
        return parts.join("\n");
      },
    },

    // ---- ACR IMAGE ANALYSIS ----
    {
      id: "aks-acr-images",
      name: "ACR Image Analysis",
      category: SKILL_CATEGORIES.SUPPLY_CHAIN,
      platforms: ["aks"],
      intents: ["supplychain", "imagescan"],
      keywords: ["acr", "azure-container-registry", "image-scan"],
      priority: 20,
      provider: "aks",
      description: "Analyze container images for Azure Container Registry usage",
      handler: async () => {
        const pods = await apiGet("/api/v1/pods?limit=500");
        const images = new Set();
        const acrImages = [];
        const externalImages = [];
        (pods.items || []).forEach(p => {
          (p.spec?.containers || []).forEach(c => {
            if (images.has(c.image)) return;
            images.add(c.image);
            if (c.image.includes(".azurecr.io")) {
              acrImages.push(c.image);
            } else {
              externalImages.push(c.image);
            }
          });
        });
        const parts = [`### ACR Image Analysis`, ""];
        parts.push(`**Total Images:** ${images.size} | **ACR:** ${acrImages.length} | **External:** ${externalImages.length}`);
        if (acrImages.length > 0) {
          parts.push("");
          parts.push(`**ACR Images:**`);
          acrImages.slice(0, 15).forEach(img => parts.push(`  - [OK] \`${img}\``));
        }
        if (externalImages.length > 0) {
          parts.push("");
          parts.push(`**External Images:**`);
          externalImages.slice(0, 10).forEach(img => parts.push(`  - [WARNING] \`${img}\``));
        }
        return parts.join("\n");
      },
    },

    // ---- AKS EXTENSIONS / ARC ----
    {
      id: "aks-extensions",
      name: "AKS Extensions & Azure Arc",
      category: SKILL_CATEGORIES.PLATFORM_SPECIFIC,
      platforms: ["aks"],
      intents: ["operators"],
      keywords: ["extension", "arc", "azure-arc", "flux", "policy", "defender"],
      priority: 15,
      provider: "aks",
      description: "Check Azure Arc agents and AKS extension health",
      handler: async () => {
        const arcAgents = {
          "Azure Arc Agent": { ns: "azure-arc", label: "app.kubernetes.io/component=connect-agent" },
          "Azure Policy": { ns: "kube-system", label: "app=azure-policy" },
          "Azure Policy Webhook": { ns: "kube-system", label: "app=azure-policy-webhook" },
          "Defender": { ns: "mdc", label: "app.kubernetes.io/name=defender-publisher" },
          "Flux": { ns: "flux-system", label: "app=source-controller" },
        };
        const parts = [`### AKS Extensions & Azure Arc`, ""];
        parts.push(`| Extension | Status | Pods |`);
        parts.push(`| --- | --- | --- |`);
        for (const [name, config] of Object.entries(arcAgents)) {
          try {
            const pods = await apiGet(`/api/v1/namespaces/${config.ns}/pods?labelSelector=${encodeURIComponent(config.label)}`);
            const items = pods.items || [];
            const running = items.filter(p => p.status?.phase === "Running").length;
            const icon = running > 0 ? "[OK]" : "[WARNING] Not found";
            parts.push(`| **${name}** | ${icon} | ${running}/${items.length} |`);
          } catch {
            parts.push(`| **${name}** | [WARNING] Not detected | — |`);
          }
        }
        return parts.join("\n");
      },
    },

    // ---- AKS-SPECIFIC NETWORK (Azure CNI) ----
    {
      id: "aks-network",
      name: "AKS Network Configuration",
      category: SKILL_CATEGORIES.NETWORKING,
      platforms: ["aks"],
      intents: ["network"],
      keywords: ["azure-cni", "kubenet", "overlay", "vnet", "subnet"],
      priority: 15,
      provider: "aks",
      description: "Detect AKS networking mode and configuration",
      handler: async () => {
        const nodes = await apiGet("/api/v1/nodes?limit=3");
        const node = (nodes.items || [])[0];
        const labels = node?.metadata?.labels || {};
        const annotations = node?.metadata?.annotations || {};

        const networkPlugin = annotations["kubernetes.azure.com/network-plugin"] || "unknown";
        const podCIDR = node?.spec?.podCIDR || "not set";

        const parts = [`### AKS Network Configuration`, ""];
        parts.push(`**Network Plugin:** ${networkPlugin}`);
        parts.push(`**Pod CIDR:** ${podCIDR}`);

        const isOverlay = podCIDR && !podCIDR.startsWith("10.244");
        if (networkPlugin === "azure") {
          parts.push(`**Mode:** Azure CNI — pods get VNet IPs directly`);
          if (isOverlay) parts.push(`**Overlay:** Enabled — pod IPs are from overlay network`);
        } else if (networkPlugin === "kubenet") {
          parts.push(`**Mode:** Kubenet — pods use NAT for external communication`);
          parts.push(`[WARNING] Kubenet has networking limitations vs Azure CNI`);
        }
        return parts.join("\n");
      },
    },
  ];

  return registerSkills(skills);
}

export { registerAKSSkills };
