/**
 * Google GKE Provider
 *
 * GKE-specific agentic skills: NEG Ingress, Workload Identity,
 * GKE node pools, Artifact Registry, Binary Authorization,
 * Config Connector, GKE Autopilot detection.
 * Inherits all shared K8s skills from base provider.
 */

import { SKILL_CATEGORIES, registerSkills } from "../skill-registry.js";
import { registerBaseSkills } from "./base.js";

function registerGKESkills(apiGet) {
  registerBaseSkills(apiGet);

  const skills = [
    // ---- GCE / NEG INGRESS ----
    {
      id: "gke-neg-ingress",
      name: "GKE NEG Ingress",
      category: SKILL_CATEGORIES.NETWORKING,
      platforms: ["gke"],
      intents: ["services", "ingress"],
      keywords: ["neg", "gce", "gke-ingress", "load-balancer", "backend-config"],
      priority: 20,
      provider: "gke",
      description: "Analyze GKE Ingress with NEG (Network Endpoint Groups) and BackendConfig",
      handler: async () => {
        const [ingresses, backendConfigs] = await Promise.all([
          apiGet("/apis/networking.k8s.io/v1/ingresses"),
          apiGet("/apis/cloud.google.com/v1/backendconfigs").catch(() => ({ items: [] })),
        ]);
        const items = ingresses.items || [];
        const gkeIngresses = items.filter(i => {
          const cls = i.spec?.ingressClassName || i.metadata?.annotations?.["kubernetes.io/ingress.class"] || "";
          return cls === "gce" || cls === "gce-internal" || !cls;
        });
        const parts = [`### GKE Ingress & Load Balancing`, ""];
        parts.push(`**Total Ingresses:** ${items.length} | **GCE-managed:** ${gkeIngresses.length} | **BackendConfigs:** ${(backendConfigs.items || []).length}`);
        if (gkeIngresses.length > 0) {
          parts.push("");
          parts.push(`| Ingress | Namespace | Host | NEG | Static IP |`);
          parts.push(`| --- | --- | --- | --- | --- |`);
          gkeIngresses.forEach(i => {
            const ann = i.metadata?.annotations || {};
            const negStatus = ann["cloud.google.com/neg-status"] ? "[OK] Yes" : "No";
            const staticIP = ann["kubernetes.io/ingress.global-static-ip-name"] || "—";
            const hosts = (i.spec?.rules || []).map(r => r.host || "*").join(", ");
            parts.push(`| \`${i.metadata.name}\` | ${i.metadata.namespace} | ${hosts} | ${negStatus} | ${staticIP} |`);
          });
        }
        return parts.join("\n");
      },
    },

    // ---- GKE WORKLOAD IDENTITY ----
    {
      id: "gke-workload-identity",
      name: "GKE Workload Identity",
      category: SKILL_CATEGORIES.IDENTITY,
      platforms: ["gke"],
      intents: ["identity", "rbac"],
      keywords: ["workload-identity", "gsa", "ksa", "iam-binding", "gcp-iam"],
      priority: 20,
      provider: "gke",
      description: "Audit GKE Workload Identity bindings between KSA and GSA",
      handler: async () => {
        const sas = await apiGet("/api/v1/serviceaccounts?limit=500");
        const wiSAs = (sas.items || []).filter(sa => {
          const ann = sa.metadata?.annotations || {};
          return ann["iam.gke.io/gcp-service-account"];
        });
        const parts = [`### GKE Workload Identity`, ""];
        parts.push(`**Total ServiceAccounts:** ${(sas.items || []).length} | **With Workload Identity:** ${wiSAs.length}`);
        if (wiSAs.length > 0) {
          parts.push("");
          parts.push(`| KSA | Namespace | GCP Service Account |`);
          parts.push(`| --- | --- | --- |`);
          wiSAs.forEach(sa => {
            const gsa = sa.metadata.annotations["iam.gke.io/gcp-service-account"];
            parts.push(`| \`${sa.metadata.name}\` | ${sa.metadata.namespace} | \`${gsa}\` |`);
          });
        } else {
          parts.push("");
          parts.push(`[WARNING] No Workload Identity bindings found. Pods may use node-level GCP credentials.`);
        }
        return parts.join("\n");
      },
    },

    // ---- GKE NODE POOLS ----
    {
      id: "gke-nodepools",
      name: "GKE Node Pools",
      category: SKILL_CATEGORIES.SCALING,
      platforms: ["gke"],
      intents: ["machines", "capacity"],
      keywords: ["nodepool", "node-pool", "gke-pool", "preemptible", "spot"],
      priority: 20,
      provider: "gke",
      description: "Analyze GKE node pools from node labels (machine type, zones, preemptibility)",
      handler: async () => {
        const nodes = await apiGet("/api/v1/nodes");
        const pools = {};
        (nodes.items || []).forEach(n => {
          const labels = n.metadata?.labels || {};
          const pool = labels["cloud.google.com/gke-nodepool"] || "default";
          const machineType = labels["node.kubernetes.io/instance-type"] || labels["beta.kubernetes.io/instance-type"] || "?";
          const zone = labels["topology.kubernetes.io/zone"] || "?";
          const preemptible = labels["cloud.google.com/gke-preemptible"] === "true" || labels["cloud.google.com/gke-spot"] === "true";
          const os = labels["cloud.google.com/gke-os-distribution"] || "linux";
          if (!pools[pool]) pools[pool] = { count: 0, types: new Set(), zones: new Set(), ready: 0, preemptible, os };
          pools[pool].count++;
          pools[pool].types.add(machineType);
          pools[pool].zones.add(zone);
          const ready = (n.status?.conditions || []).find(c => c.type === "Ready");
          if (ready?.status === "True") pools[pool].ready++;
        });
        const parts = [`### GKE Node Pools`, ""];
        parts.push(`| Pool | Nodes | Ready | Machine Type(s) | Zones | Spot/Preemptible | OS |`);
        parts.push(`| --- | --- | --- | --- | --- | --- | --- |`);
        Object.entries(pools).forEach(([pool, data]) => {
          const icon = data.ready === data.count ? "[OK]" : "[WARNING]";
          const spot = data.preemptible ? "Yes" : "No";
          parts.push(`| ${icon} \`${pool}\` | ${data.count} | ${data.ready} | ${[...data.types].join(", ")} | ${[...data.zones].join(", ")} | ${spot} | ${data.os} |`);
        });
        return parts.join("\n");
      },
    },

    // ---- ARTIFACT REGISTRY ----
    {
      id: "gke-gar-images",
      name: "Artifact Registry Analysis",
      category: SKILL_CATEGORIES.SUPPLY_CHAIN,
      platforms: ["gke"],
      intents: ["supplychain", "imagescan"],
      keywords: ["gar", "gcr", "artifact-registry", "container-registry"],
      priority: 20,
      provider: "gke",
      description: "Analyze container images for GCP Artifact Registry / GCR usage",
      handler: async () => {
        const pods = await apiGet("/api/v1/pods?limit=500");
        const images = new Set();
        const garImages = [];
        const externalImages = [];
        (pods.items || []).forEach(p => {
          (p.spec?.containers || []).forEach(c => {
            if (images.has(c.image)) return;
            images.add(c.image);
            if (c.image.includes("-docker.pkg.dev") || c.image.includes("gcr.io")) {
              garImages.push(c.image);
            } else {
              externalImages.push(c.image);
            }
          });
        });
        const parts = [`### Artifact Registry / GCR Analysis`, ""];
        parts.push(`**Total Images:** ${images.size} | **GAR/GCR:** ${garImages.length} | **External:** ${externalImages.length}`);
        if (garImages.length > 0) {
          parts.push("");
          parts.push(`**GAR/GCR Images:**`);
          garImages.slice(0, 15).forEach(img => parts.push(`  - [OK] \`${img}\``));
        }
        if (externalImages.length > 0) {
          parts.push("");
          parts.push(`**External Images:**`);
          externalImages.slice(0, 10).forEach(img => parts.push(`  - [WARNING] \`${img}\``));
        }
        return parts.join("\n");
      },
    },

    // ---- BINARY AUTHORIZATION ----
    {
      id: "gke-binary-auth",
      name: "Binary Authorization",
      category: SKILL_CATEGORIES.SECURITY,
      platforms: ["gke"],
      intents: ["supplychain", "security"],
      keywords: ["binary-auth", "binary-authorization", "attestation", "binauthz"],
      priority: 15,
      provider: "gke",
      description: "Check Binary Authorization policy and attestation requirements",
      handler: async () => {
        const baPolicies = await apiGet("/apis/binaryauthorization.googleapis.com/v1/policies").catch(() => ({ items: [] }));
        const parts = [`### Binary Authorization`, ""];
        if ((baPolicies.items || []).length > 0) {
          parts.push(`[OK] Binary Authorization policies detected`);
          (baPolicies.items || []).slice(0, 10).forEach(p => {
            parts.push(`  - \`${p.metadata?.name || "policy"}\``);
          });
        } else {
          parts.push(`[WARNING] No Binary Authorization policies found.`);
          parts.push(`Consider enabling Binary Authorization for image provenance verification.`);
        }
        return parts.join("\n");
      },
    },

    // ---- CONFIG CONNECTOR ----
    {
      id: "gke-config-connector",
      name: "Config Connector",
      category: SKILL_CATEGORIES.PLATFORM_SPECIFIC,
      platforms: ["gke"],
      intents: ["operators"],
      keywords: ["config-connector", "cnrm", "gcp-resources"],
      priority: 15,
      provider: "gke",
      description: "Check GKE Config Connector for managing GCP resources via K8s",
      handler: async () => {
        const ccPods = await apiGet("/api/v1/namespaces/cnrm-system/pods").catch(() => ({ items: [] }));
        const items = ccPods.items || [];
        const parts = [`### Config Connector`, ""];
        if (items.length > 0) {
          const running = items.filter(p => p.status?.phase === "Running").length;
          parts.push(`[OK] Config Connector installed — ${running}/${items.length} pods running`);
          parts.push("");
          try {
            const ccs = await apiGet("/apis/core.cnrm.cloud.google.com/v1beta1/configconnectorcontexts").catch(() => ({ items: [] }));
            if ((ccs.items || []).length > 0) {
              parts.push(`**ConfigConnectorContexts:** ${ccs.items.length}`);
            }
          } catch { /* skip */ }
        } else {
          parts.push(`Config Connector not installed. It allows managing GCP resources via K8s manifests.`);
        }
        return parts.join("\n");
      },
    },

    // ---- GKE AUTOPILOT DETECTION ----
    {
      id: "gke-autopilot",
      name: "GKE Autopilot Detection",
      category: SKILL_CATEGORIES.PLATFORM_SPECIFIC,
      platforms: ["gke"],
      intents: ["cluster_health"],
      keywords: ["autopilot", "standard", "gke-mode"],
      priority: 10,
      provider: "gke",
      description: "Detect whether the cluster is GKE Standard or Autopilot",
      handler: async () => {
        const nodes = await apiGet("/api/v1/nodes?limit=1");
        const node = (nodes.items || [])[0];
        const labels = node?.metadata?.labels || {};
        const isAutopilot = labels["cloud.google.com/gke-autopilot"] === "true";
        const parts = [`### GKE Cluster Mode`, ""];
        if (isAutopilot) {
          parts.push(`**Mode:** [OK] Autopilot`);
          parts.push(`- Google manages node infrastructure`);
          parts.push(`- Pay-per-pod billing model`);
          parts.push(`- Security best practices enforced`);
          parts.push(`- Some workload restrictions apply (privileged pods, host networking)`);
        } else {
          parts.push(`**Mode:** Standard`);
          parts.push(`- Full node management control`);
          parts.push(`- Manual node pool configuration`);
        }
        return parts.join("\n");
      },
    },

    // ---- GKE MANAGED CERTIFICATES ----
    {
      id: "gke-managed-certs",
      name: "GKE Managed Certificates",
      category: SKILL_CATEGORIES.SECURITY,
      platforms: ["gke"],
      intents: ["certificate_expiry", "certlife"],
      keywords: ["managed-certificate", "ssl-cert", "gke-cert"],
      priority: 15,
      provider: "gke",
      description: "Check Google-managed SSL certificates for Ingress",
      handler: async () => {
        const mcs = await apiGet("/apis/networking.gke.io/v1/managedcertificates").catch(() => ({ items: [] }));
        const items = mcs.items || [];
        const parts = [`### GKE Managed Certificates`, ""];
        if (items.length > 0) {
          parts.push(`| Certificate | Namespace | Domains | Status |`);
          parts.push(`| --- | --- | --- | --- |`);
          items.forEach(c => {
            const domains = (c.spec?.domains || []).join(", ");
            const status = c.status?.certificateStatus || "Unknown";
            const icon = status === "Active" ? "[OK]" : "[WARNING]";
            parts.push(`| ${icon} \`${c.metadata.name}\` | ${c.metadata.namespace} | ${domains} | ${status} |`);
          });
        } else {
          parts.push(`No Google-managed certificates found. Using cert-manager or self-managed TLS.`);
        }
        return parts.join("\n");
      },
    },
  ];

  return registerSkills(skills);
}

export { registerGKESkills };
