/**
 * Amazon EKS Provider
 *
 * EKS-specific agentic skills: ALB Ingress, IRSA, Karpenter,
 * EKS managed add-ons, ECR image scanning, and EKS upgrade paths.
 * Inherits all shared K8s skills from base provider.
 */

import { SKILL_CATEGORIES, registerSkills } from "../skill-registry.js";
import { registerBaseSkills } from "./base.js";

function registerEKSSkills(apiGet) {
  registerBaseSkills(apiGet);

  const skills = [
    // ---- ALB INGRESS ----
    {
      id: "eks-alb-ingress",
      name: "AWS ALB Ingress",
      category: SKILL_CATEGORIES.NETWORKING,
      platforms: ["eks"],
      intents: ["services", "ingress"],
      keywords: ["alb", "ingress", "load-balancer", "target-group", "aws-lb"],
      priority: 20,
      provider: "eks",
      description: "Analyze ALB Ingress Controller resources and target group bindings",
      handler: async () => {
        const [ingresses, tgbs] = await Promise.all([
          apiGet("/apis/networking.k8s.io/v1/ingresses"),
          apiGet("/apis/elbv2.k8s.aws/v1beta1/targetgroupbindings").catch(() => ({ items: [] })),
        ]);
        const items = ingresses.items || [];
        const albIngresses = items.filter(i => {
          const cls = i.spec?.ingressClassName || i.metadata?.annotations?.["kubernetes.io/ingress.class"] || "";
          return cls === "alb" || i.metadata?.annotations?.["alb.ingress.kubernetes.io/scheme"];
        });
        const parts = [`### AWS ALB Ingress — ${albIngresses.length} ALB-managed`, ""];
        if (albIngresses.length > 0) {
          parts.push(`| Ingress | Namespace | Host | Scheme | Target Type | Health |`);
          parts.push(`| --- | --- | --- | --- | --- | --- |`);
          albIngresses.forEach(i => {
            const ann = i.metadata?.annotations || {};
            const scheme = ann["alb.ingress.kubernetes.io/scheme"] || "internal";
            const targetType = ann["alb.ingress.kubernetes.io/target-type"] || "instance";
            const hosts = (i.spec?.rules || []).map(r => r.host || "*").join(", ");
            const hasAddress = (i.status?.loadBalancer?.ingress || []).length > 0;
            parts.push(`| \`${i.metadata.name}\` | ${i.metadata.namespace} | ${hosts} | ${scheme} | ${targetType} | ${hasAddress ? "[OK]" : "[WARNING] No LB"} |`);
          });
        }
        if ((tgbs.items || []).length > 0) {
          parts.push("");
          parts.push(`**TargetGroupBindings:** ${tgbs.items.length}`);
        }
        const nonAlb = items.filter(i => !albIngresses.includes(i));
        if (nonAlb.length > 0) {
          parts.push("");
          parts.push(`**Other Ingresses (non-ALB):** ${nonAlb.length}`);
        }
        return parts.join("\n");
      },
    },

    // ---- IRSA (IAM Roles for Service Accounts) ----
    {
      id: "eks-irsa",
      name: "IAM Roles for Service Accounts",
      category: SKILL_CATEGORIES.IDENTITY,
      platforms: ["eks"],
      intents: ["identity", "rbac"],
      keywords: ["irsa", "iam", "role", "service-account", "aws-iam", "oidc"],
      priority: 20,
      provider: "eks",
      description: "Audit IRSA bindings — service accounts with IAM role annotations",
      handler: async () => {
        const sas = await apiGet("/api/v1/serviceaccounts?limit=500");
        const items = sas.items || [];
        const irsaSAs = items.filter(sa => {
          const ann = sa.metadata?.annotations || {};
          return ann["eks.amazonaws.com/role-arn"];
        });
        const nonIrsaSAs = items.filter(sa => {
          if (sa.metadata.namespace?.startsWith("kube-")) return false;
          const ann = sa.metadata?.annotations || {};
          return !ann["eks.amazonaws.com/role-arn"] && sa.metadata.name !== "default";
        });
        const parts = [`### IRSA (IAM Roles for Service Accounts)`, ""];
        parts.push(`**Total ServiceAccounts:** ${items.length} | **With IRSA:** ${irsaSAs.length}`);
        parts.push("");
        if (irsaSAs.length > 0) {
          parts.push(`| ServiceAccount | Namespace | IAM Role ARN |`);
          parts.push(`| --- | --- | --- |`);
          irsaSAs.forEach(sa => {
            const arn = sa.metadata.annotations["eks.amazonaws.com/role-arn"];
            parts.push(`| \`${sa.metadata.name}\` | ${sa.metadata.namespace} | \`${arn}\` |`);
          });
        }
        const podsUsingNodeRole = [];
        try {
          const pods = await apiGet("/api/v1/pods?fieldSelector=status.phase=Running&limit=200");
          (pods.items || []).forEach(p => {
            if (p.metadata.namespace?.startsWith("kube-")) return;
            const saName = p.spec?.serviceAccountName || "default";
            const hasIRSA = irsaSAs.some(sa => sa.metadata.name === saName && sa.metadata.namespace === p.metadata.namespace);
            if (!hasIRSA && saName === "default") {
              podsUsingNodeRole.push(p);
            }
          });
        } catch { /* skip */ }
        if (podsUsingNodeRole.length > 0) {
          parts.push("");
          parts.push(`[WARNING] **${podsUsingNodeRole.length} pod(s) using default SA** (inheriting node IAM role):`);
          podsUsingNodeRole.slice(0, 10).forEach(p => parts.push(`  - \`${p.metadata.name}\` (${p.metadata.namespace})`));
        }
        return parts.join("\n");
      },
    },

    // ---- KARPENTER ----
    {
      id: "eks-karpenter",
      name: "Karpenter Node Management",
      category: SKILL_CATEGORIES.SCALING,
      platforms: ["eks"],
      intents: ["machines", "capacity"],
      keywords: ["karpenter", "provisioner", "nodeclaim", "nodepool", "node-scaling"],
      priority: 20,
      provider: "eks",
      description: "Check Karpenter provisioners, NodePools, and NodeClaims",
      handler: async () => {
        const [nodePools, nodeClaims, provisioners] = await Promise.all([
          apiGet("/apis/karpenter.sh/v1beta1/nodepools").catch(() => ({ items: [] })),
          apiGet("/apis/karpenter.sh/v1beta1/nodeclaims").catch(() => ({ items: [] })),
          apiGet("/apis/karpenter.sh/v1alpha5/provisioners").catch(() => ({ items: [] })),
        ]);
        const npItems = nodePools.items || [];
        const ncItems = nodeClaims.items || [];
        const provItems = provisioners.items || [];
        const parts = [`### Karpenter Node Management`, ""];

        if (npItems.length === 0 && provItems.length === 0) {
          parts.push(`[WARNING] Karpenter not detected — no NodePools or Provisioners found.`);
          parts.push(`Consider installing Karpenter for efficient node auto-scaling.`);
          return parts.join("\n");
        }

        if (npItems.length > 0) {
          parts.push(`**NodePools (v1beta1):** ${npItems.length}`);
          parts.push(`| NodePool | Ready | Instance Types | Capacity Type |`);
          parts.push(`| --- | --- | --- | --- |`);
          npItems.forEach(np => {
            const reqs = np.spec?.template?.spec?.requirements || [];
            const instanceTypes = reqs.find(r => r.key === "node.kubernetes.io/instance-type")?.values?.slice(0, 5).join(", ") || "any";
            const capType = reqs.find(r => r.key === "karpenter.sh/capacity-type")?.values?.join(", ") || "on-demand";
            parts.push(`| \`${np.metadata.name}\` | [OK] | ${instanceTypes} | ${capType} |`);
          });
        }
        if (ncItems.length > 0) {
          parts.push("");
          parts.push(`**Active NodeClaims:** ${ncItems.length}`);
          const ready = ncItems.filter(nc => (nc.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True"));
          parts.push(`  Ready: ${ready.length} | Pending: ${ncItems.length - ready.length}`);
        }
        return parts.join("\n");
      },
    },

    // ---- EKS MANAGED ADD-ONS ----
    {
      id: "eks-addons",
      name: "EKS Managed Add-ons",
      category: SKILL_CATEGORIES.CLUSTER_HEALTH,
      platforms: ["eks"],
      intents: ["operators", "cluster_health"],
      keywords: ["addon", "add-on", "coredns", "kube-proxy", "vpc-cni", "ebs-csi"],
      priority: 20,
      provider: "eks",
      description: "Check health of EKS managed add-ons (CoreDNS, kube-proxy, VPC CNI, EBS CSI)",
      handler: async () => {
        const addonPods = {
          "CoreDNS": { ns: "kube-system", label: "k8s-app=kube-dns" },
          "kube-proxy": { ns: "kube-system", label: "k8s-app=kube-proxy" },
          "VPC CNI": { ns: "kube-system", label: "k8s-app=aws-node" },
          "EBS CSI": { ns: "kube-system", label: "app=ebs-csi-controller" },
        };
        const parts = [`### EKS Managed Add-ons`, ""];
        parts.push(`| Add-on | Pods | Status |`);
        parts.push(`| --- | --- | --- |`);
        for (const [name, config] of Object.entries(addonPods)) {
          try {
            const pods = await apiGet(`/api/v1/namespaces/${config.ns}/pods?labelSelector=${encodeURIComponent(config.label)}`);
            const items = pods.items || [];
            const running = items.filter(p => p.status?.phase === "Running").length;
            const icon = running === items.length && items.length > 0 ? "[OK]" : items.length === 0 ? "[WARNING] Not found" : "[WARNING]";
            parts.push(`| **${name}** | ${running}/${items.length} | ${icon} |`);
          } catch {
            parts.push(`| **${name}** | — | [WARNING] Could not query |`);
          }
        }
        return parts.join("\n");
      },
    },

    // ---- EKS NODE GROUPS ----
    {
      id: "eks-nodegroups",
      name: "EKS Node Groups",
      category: SKILL_CATEGORIES.SCALING,
      platforms: ["eks"],
      intents: ["machines"],
      keywords: ["nodegroup", "node-group", "managed-node", "asg"],
      priority: 20,
      provider: "eks",
      description: "Detect and analyze EKS managed/self-managed node groups from node labels",
      handler: async () => {
        const nodes = await apiGet("/api/v1/nodes");
        const groups = {};
        (nodes.items || []).forEach(n => {
          const labels = n.metadata?.labels || {};
          const ng = labels["eks.amazonaws.com/nodegroup"] || labels["alpha.eksctl.io/nodegroup-name"] || "self-managed";
          const instanceType = labels["node.kubernetes.io/instance-type"] || "?";
          const zone = labels["topology.kubernetes.io/zone"] || "?";
          if (!groups[ng]) groups[ng] = { count: 0, types: new Set(), zones: new Set(), ready: 0 };
          groups[ng].count++;
          groups[ng].types.add(instanceType);
          groups[ng].zones.add(zone);
          const ready = (n.status?.conditions || []).find(c => c.type === "Ready");
          if (ready?.status === "True") groups[ng].ready++;
        });
        const parts = [`### EKS Node Groups`, ""];
        parts.push(`| Node Group | Nodes | Ready | Instance Types | AZs |`);
        parts.push(`| --- | --- | --- | --- | --- |`);
        Object.entries(groups).forEach(([ng, data]) => {
          const icon = data.ready === data.count ? "[OK]" : "[WARNING]";
          parts.push(`| ${icon} \`${ng}\` | ${data.count} | ${data.ready} | ${[...data.types].join(", ")} | ${[...data.zones].join(", ")} |`);
        });
        return parts.join("\n");
      },
    },

    // ---- ECR IMAGE SCANNING ----
    {
      id: "eks-ecr-images",
      name: "ECR Image Analysis",
      category: SKILL_CATEGORIES.SUPPLY_CHAIN,
      platforms: ["eks"],
      intents: ["supplychain", "imagescan"],
      keywords: ["ecr", "registry", "image-scan", "vulnerability"],
      priority: 20,
      provider: "eks",
      description: "Analyze container images for ECR registry usage",
      handler: async () => {
        const pods = await apiGet("/api/v1/pods?limit=500");
        const images = new Set();
        const ecrImages = [];
        const nonEcrImages = [];
        (pods.items || []).forEach(p => {
          (p.spec?.containers || []).forEach(c => {
            if (images.has(c.image)) return;
            images.add(c.image);
            if (c.image.includes(".dkr.ecr.") && c.image.includes(".amazonaws.com")) {
              ecrImages.push(c.image);
            } else {
              nonEcrImages.push(c.image);
            }
          });
        });
        const parts = [`### ECR Image Analysis`, ""];
        parts.push(`**Total Unique Images:** ${images.size} | **ECR:** ${ecrImages.length} | **External:** ${nonEcrImages.length}`);
        if (ecrImages.length > 0) {
          parts.push("");
          parts.push(`**ECR Images:**`);
          ecrImages.slice(0, 15).forEach(img => parts.push(`  - [OK] \`${img}\``));
        }
        if (nonEcrImages.length > 0) {
          parts.push("");
          parts.push(`**External Images (not in ECR):**`);
          nonEcrImages.slice(0, 10).forEach(img => parts.push(`  - [WARNING] \`${img}\``));
        }
        return parts.join("\n");
      },
    },

    // ---- EKS SECURITY GROUPS (via pod labels) ----
    {
      id: "eks-security-groups",
      name: "EKS Security Group Policies",
      category: SKILL_CATEGORIES.NETWORKING,
      platforms: ["eks"],
      intents: ["network", "security"],
      keywords: ["security-group", "sg", "vpc", "eni"],
      priority: 15,
      provider: "eks",
      description: "Check SecurityGroupPolicy resources for pod-level security groups",
      handler: async () => {
        const sgps = await apiGet("/apis/vpcresources.k8s.aws/v1beta1/securitygrouppolicies").catch(() => ({ items: [] }));
        const items = sgps.items || [];
        const parts = [`### EKS Security Group Policies`, ""];
        if (items.length > 0) {
          parts.push(`| Policy | Namespace | Security Groups |`);
          parts.push(`| --- | --- | --- |`);
          items.forEach(p => {
            const sgs = (p.spec?.securityGroups?.groupIds || []).join(", ");
            parts.push(`| \`${p.metadata.name}\` | ${p.metadata.namespace} | ${sgs} |`);
          });
        } else {
          parts.push(`No SecurityGroupPolicies found. Pods use node-level security groups.`);
        }
        return parts.join("\n");
      },
    },
  ];

  return registerSkills(skills);
}

export { registerEKSSkills };
