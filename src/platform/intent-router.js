/**
 * Intent Router — Cross-Platform Abstraction Layer
 *
 * Maps abstract operational intents to platform-specific actions,
 * CLI commands, and system-prompt guidance. This module allows the
 * orchestrator and LLM prompt builder to stay platform-agnostic
 * while injecting the correct platform-native instructions at runtime.
 *
 * Supported platforms:
 *   openshift, rosa, aro  — Red Hat OpenShift family
 *   eks                    — Amazon Elastic Kubernetes Service
 *   aks                    — Azure Kubernetes Service
 *   gke                    — Google Kubernetes Engine
 *   k8s                    — Vanilla / upstream Kubernetes
 */

import { PLATFORM, PLATFORM_LABELS } from "./detect.js";

// ---------------------------------------------------------------------------
// Platform metadata used for prompt generation
// ---------------------------------------------------------------------------

const PLATFORM_META = {
  [PLATFORM.OPENSHIFT]: {
    label: "Red Hat OpenShift",
    cliSummary: "oc (OpenShift CLI)",
  },
  [PLATFORM.ROSA]: {
    label: "Red Hat OpenShift on AWS (ROSA)",
    cliSummary: "oc (rosa CLI for cluster lifecycle)",
  },
  [PLATFORM.ARO]: {
    label: "Azure Red Hat OpenShift (ARO)",
    cliSummary: "oc (az aro for cluster lifecycle)",
  },
  [PLATFORM.EKS]: {
    label: "Amazon EKS",
    cliSummary: "kubectl (eksctl for cluster operations)",
  },
  [PLATFORM.AKS]: {
    label: "Azure AKS",
    cliSummary: "kubectl (az aks for cluster operations)",
  },
  [PLATFORM.GKE]: {
    label: "Google GKE",
    cliSummary: "kubectl (gcloud container for cluster operations)",
  },
  [PLATFORM.K8S]: {
    label: "Kubernetes (vanilla)",
    cliSummary: "kubectl",
  },
};

// ---------------------------------------------------------------------------
// Command reference per platform
// ---------------------------------------------------------------------------

function buildCommandRef(platform) {
  const isOCP = ["openshift", "rosa", "aro"].includes(platform);
  const cli = isOCP ? "oc" : "kubectl";

  const base = {
    cli,
    getpods: `${cli} get pods`,
    logs: `${cli} logs`,
    describe: `${cli} describe`,
    apply: `${cli} apply`,
    scale: `${cli} scale`,
    rollout: `${cli} rollout`,
    exec: `${cli} exec`,
  };

  const platformExtensions = {
    openshift: {
      expose: "oc expose svc/<name> OR oc create route edge --service=<name>",
      nodeScale: "oc scale machineset <name> --replicas=<n> -n openshift-machine-api",
      identity: "oc get oauthclient; oc adm policy add-scc-to-user <scc> -z <sa>",
      monitoring: "oc -n openshift-monitoring get pods; oc get prometheusrule",
    },
    rosa: {
      expose: "oc expose svc/<name> OR oc create route edge --service=<name>",
      nodeScale: "rosa edit machinepool --cluster=<id> --replicas=<n> <pool>",
      identity: "oc get oauthclient; rosa create idp --cluster=<id> --type=<type>",
      monitoring: "oc -n openshift-monitoring get pods; oc get prometheusrule",
    },
    aro: {
      expose: "oc expose svc/<name> OR oc create route edge --service=<name>",
      nodeScale: "oc scale machineset <name> --replicas=<n> -n openshift-machine-api",
      identity: "oc get oauthclient; az aro list-credentials --name <aro> --resource-group <rg>",
      monitoring: "oc -n openshift-monitoring get pods; oc get prometheusrule",
    },
    eks: {
      expose: "kubectl apply -f ingress.yaml  # with kubernetes.io/ingress.class: alb annotation",
      nodeScale: "eksctl scale nodegroup --cluster=<name> --name=<ng> --nodes=<n>",
      identity: "eksctl create iamserviceaccount --name <sa> --namespace <ns> --cluster <cluster> --attach-policy-arn <arn>",
      monitoring: "kubectl get pods -n amazon-cloudwatch; aws cloudwatch get-metric-data",
    },
    aks: {
      expose: "kubectl expose deployment <name> --type=LoadBalancer --port=<port>",
      nodeScale: "az aks nodepool scale --resource-group <rg> --cluster-name <cluster> --name <pool> --node-count <n>",
      identity: "az aks pod-identity add --resource-group <rg> --cluster-name <cluster> --namespace <ns> --name <name> --identity-resource-id <id>",
      monitoring: "kubectl get pods -n kube-system -l component=oms-agent; az monitor log-analytics query",
    },
    gke: {
      expose: "kubectl apply -f gateway.yaml  # using Gateway API or Ingress with NEG",
      nodeScale: "gcloud container clusters resize <cluster> --node-pool <pool> --num-nodes <n>",
      identity: "gcloud iam service-accounts add-iam-policy-binding <gsa>@<project>.iam.gserviceaccount.com --role roles/iam.workloadIdentityUser --member 'serviceAccount:<project>.svc.id.goog[<ns>/<ksa>]'",
      monitoring: "kubectl get pods -n gke-managed-system; gcloud logging read 'resource.type=\"k8s_container\"'",
    },
    k8s: {
      expose: "kubectl expose deployment <name> --type=NodePort --port=<port>  # or create an Ingress resource",
      nodeScale: "# Manual — add/remove nodes to the cluster using your provisioning tool",
      identity: "kubectl create serviceaccount <name>; kubectl create rolebinding <name> --clusterrole=<role> --serviceaccount=<ns>:<sa>",
      monitoring: "kubectl top pods; kubectl top nodes  # requires metrics-server",
    },
  };

  return { ...base, ...platformExtensions[platform] };
}

// ---------------------------------------------------------------------------
// Abstract operation → platform-specific mapping table
// ---------------------------------------------------------------------------

const ABSTRACT_MAPPINGS = {
  // ---- Networking ----
  expose_service: {
    openshift: {
      summary: "Create an OpenShift Route (edge, passthrough, or re-encrypt)",
      commands: ["oc expose svc/<name>", "oc create route edge --service=<name> --hostname=<host>"],
      resources: ["Route"],
      notes: "Routes are native to OpenShift; no Ingress controller needed. Use `oc get routes` to verify.",
    },
    rosa: {
      summary: "Create an OpenShift Route (edge, passthrough, or re-encrypt)",
      commands: ["oc expose svc/<name>", "oc create route edge --service=<name> --hostname=<host>"],
      resources: ["Route"],
      notes: "ROSA clusters use the OpenShift Router with AWS NLB/CLB by default.",
    },
    aro: {
      summary: "Create an OpenShift Route (edge, passthrough, or re-encrypt)",
      commands: ["oc expose svc/<name>", "oc create route edge --service=<name> --hostname=<host>"],
      resources: ["Route"],
      notes: "ARO clusters use the OpenShift Router with Azure Load Balancer integration.",
    },
    eks: {
      summary: "Use AWS ALB Ingress Controller with `kubernetes.io/ingress.class: alb` annotation",
      commands: [
        "kubectl apply -f ingress.yaml  # with alb.ingress.kubernetes.io/scheme: internet-facing",
        "kubectl get ingress <name> -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'",
      ],
      resources: ["Ingress", "TargetGroupBinding"],
      notes: "Ensure the AWS Load Balancer Controller is installed. Use `alb.ingress.kubernetes.io/target-type: ip` for Fargate.",
    },
    aks: {
      summary: "Create a LoadBalancer Service or use Azure Application Gateway Ingress Controller (AGIC)",
      commands: [
        "kubectl expose deployment <name> --type=LoadBalancer --port=<port>",
        "kubectl apply -f ingress.yaml  # with kubernetes.io/ingress.class: azure/application-gateway",
      ],
      resources: ["Service (LoadBalancer)", "Ingress"],
      notes: "AKS natively provisions Azure Load Balancers for LoadBalancer-type Services. Use AGIC for L7 routing.",
    },
    gke: {
      summary: "Use Gateway API or GKE Ingress with Google Cloud Load Balancer",
      commands: [
        "kubectl apply -f gateway.yaml  # Gateway API with GKE Gateway Controller",
        "kubectl apply -f ingress.yaml  # GKE Ingress (creates GCLB)",
      ],
      resources: ["Gateway", "HTTPRoute", "Ingress"],
      notes: "GKE supports Gateway API natively. Use `cloud.google.com/neg: '{\"ingress\": true}'` annotation for container-native load balancing.",
    },
    k8s: {
      summary: "Create an Ingress resource or NodePort/LoadBalancer Service",
      commands: [
        "kubectl apply -f ingress.yaml",
        "kubectl expose deployment <name> --type=NodePort --port=<port>",
      ],
      resources: ["Ingress", "Service"],
      notes: "Requires an Ingress controller (NGINX, Traefik, etc.) to be installed in the cluster.",
    },
  },

  check_ingress: {
    openshift: {
      summary: "List and inspect OpenShift Routes",
      commands: ["oc get routes -A", "oc describe route <name> -n <ns>"],
      resources: ["Route"],
      notes: "Check the Admitted status and router canonical hostname.",
    },
    rosa: {
      summary: "List and inspect OpenShift Routes",
      commands: ["oc get routes -A", "oc describe route <name> -n <ns>"],
      resources: ["Route"],
      notes: "Check the Admitted status and router canonical hostname. Verify AWS NLB health.",
    },
    aro: {
      summary: "List and inspect OpenShift Routes",
      commands: ["oc get routes -A", "oc describe route <name> -n <ns>"],
      resources: ["Route"],
      notes: "Check the Admitted status and router canonical hostname. Verify Azure LB health.",
    },
    eks: {
      summary: "Check ALB Ingress resources and target group health",
      commands: [
        "kubectl get ingress -A",
        "kubectl describe ingress <name> -n <ns>",
        "aws elbv2 describe-target-health --target-group-arn <arn>",
      ],
      resources: ["Ingress", "TargetGroupBinding"],
      notes: "Verify ALB is provisioned and targets are healthy. Check AWS LB Controller logs if ingress has no address.",
    },
    aks: {
      summary: "Check Azure Load Balancer and Ingress status",
      commands: [
        "kubectl get ingress -A",
        "kubectl get svc -A --field-selector spec.type=LoadBalancer",
        "az network lb show --resource-group <rg> --name <lb>",
      ],
      resources: ["Ingress", "Service"],
      notes: "Verify the Azure LB has healthy backend pools. Check AGIC logs if using Application Gateway.",
    },
    gke: {
      summary: "Check GKE Ingress/Gateway and backend health",
      commands: [
        "kubectl get ingress -A",
        "kubectl get gateway -A",
        "kubectl describe ingress <name> -n <ns>",
      ],
      resources: ["Ingress", "Gateway", "HTTPRoute"],
      notes: "Check the backend services health in the GCP Console or via `gcloud compute backend-services get-health`.",
    },
    k8s: {
      summary: "Check Ingress resources and controller status",
      commands: [
        "kubectl get ingress -A",
        "kubectl describe ingress <name> -n <ns>",
        "kubectl get pods -n ingress-nginx",
      ],
      resources: ["Ingress"],
      notes: "Verify the Ingress controller pods are running and the Ingress has an ADDRESS assigned.",
    },
  },

  network_policy: {
    openshift: {
      summary: "Manage NetworkPolicy and EgressNetworkPolicy resources",
      commands: [
        "oc get networkpolicy -A",
        "oc get egressnetworkpolicy -A",
        "oc describe networkpolicy <name> -n <ns>",
      ],
      resources: ["NetworkPolicy", "EgressNetworkPolicy"],
      notes: "OpenShift SDN and OVN-Kubernetes both support NetworkPolicy. OpenShift also provides EgressNetworkPolicy for namespace egress control.",
    },
    rosa: {
      summary: "Manage NetworkPolicy and EgressNetworkPolicy resources",
      commands: [
        "oc get networkpolicy -A",
        "oc get egressnetworkpolicy -A",
      ],
      resources: ["NetworkPolicy", "EgressNetworkPolicy"],
      notes: "ROSA uses OVN-Kubernetes by default. Both NetworkPolicy and EgressNetworkPolicy are supported.",
    },
    aro: {
      summary: "Manage NetworkPolicy and EgressNetworkPolicy resources",
      commands: [
        "oc get networkpolicy -A",
        "oc get egressnetworkpolicy -A",
      ],
      resources: ["NetworkPolicy", "EgressNetworkPolicy"],
      notes: "ARO uses OpenShift SDN or OVN-Kubernetes. Both NetworkPolicy and EgressNetworkPolicy are supported.",
    },
    eks: {
      summary: "Manage Kubernetes NetworkPolicy (requires a CNI that supports it)",
      commands: [
        "kubectl get networkpolicy -A",
        "kubectl describe networkpolicy <name> -n <ns>",
      ],
      resources: ["NetworkPolicy"],
      notes: "The default VPC CNI does NOT enforce NetworkPolicy. Install Calico or use VPC CNI with network policy support (v1.14+) to enforce policies.",
    },
    aks: {
      summary: "Manage Kubernetes NetworkPolicy (Azure CNI or Calico)",
      commands: [
        "kubectl get networkpolicy -A",
        "kubectl describe networkpolicy <name> -n <ns>",
      ],
      resources: ["NetworkPolicy"],
      notes: "AKS supports NetworkPolicy via Azure NPM (azure network policy) or Calico. Must be enabled at cluster creation.",
    },
    gke: {
      summary: "Manage Kubernetes NetworkPolicy (Dataplane V2 or Calico)",
      commands: [
        "kubectl get networkpolicy -A",
        "kubectl describe networkpolicy <name> -n <ns>",
      ],
      resources: ["NetworkPolicy"],
      notes: "GKE Dataplane V2 (Cilium-based) enforces NetworkPolicy natively. For Standard clusters, enable the network policy add-on.",
    },
    k8s: {
      summary: "Manage Kubernetes NetworkPolicy",
      commands: [
        "kubectl get networkpolicy -A",
        "kubectl describe networkpolicy <name> -n <ns>",
      ],
      resources: ["NetworkPolicy"],
      notes: "NetworkPolicy enforcement depends on the CNI plugin (Calico, Cilium, Weave Net, etc.). Verify your CNI supports it.",
    },
  },

  // ---- Identity & Access ----
  check_sa_security: {
    openshift: {
      summary: "Audit SecurityContextConstraints (SCC) and OAuth integration",
      commands: [
        "oc get scc",
        "oc describe scc <name>",
        "oc adm policy who-can use scc restricted-v2",
        "oc get oauthclient",
      ],
      resources: ["SecurityContextConstraint", "OAuthClient", "ServiceAccount"],
      notes: "OpenShift uses SCCs instead of Pod Security Standards. Check which SCCs are bound to service accounts and avoid granting `anyuid` or `privileged`.",
    },
    rosa: {
      summary: "Audit SecurityContextConstraints (SCC) and identity providers",
      commands: [
        "oc get scc",
        "oc describe scc <name>",
        "rosa list idps --cluster=<id>",
      ],
      resources: ["SecurityContextConstraint", "OAuthClient", "ServiceAccount"],
      notes: "ROSA uses SCCs like standard OpenShift. Use `rosa` CLI to manage identity providers (GitHub, LDAP, etc.).",
    },
    aro: {
      summary: "Audit SecurityContextConstraints (SCC) and Azure AD integration",
      commands: [
        "oc get scc",
        "oc describe scc <name>",
        "oc get oauthclient",
        "az aro show --name <aro> --resource-group <rg>",
      ],
      resources: ["SecurityContextConstraint", "OAuthClient", "ServiceAccount"],
      notes: "ARO integrates with Azure AD for authentication. Check both SCCs and Azure RBAC assignments.",
    },
    eks: {
      summary: "Audit IAM Roles for Service Accounts (IRSA) configuration",
      commands: [
        "kubectl get sa -A -o json | jq '.items[] | select(.metadata.annotations[\"eks.amazonaws.com/role-arn\"])'",
        "eksctl get iamserviceaccount --cluster <name>",
        "aws eks describe-cluster --name <cluster> --query 'cluster.identity.oidc'",
      ],
      resources: ["ServiceAccount", "IAM Role", "OIDC Provider"],
      notes: "EKS uses IRSA to grant AWS permissions to pods. Verify the OIDC provider is configured and SA annotations include `eks.amazonaws.com/role-arn`.",
    },
    aks: {
      summary: "Audit Workload Identity and Azure AD integration",
      commands: [
        "kubectl get sa -A -o json | jq '.items[] | select(.metadata.annotations[\"azure.workload.identity/client-id\"])'",
        "az aks show --resource-group <rg> --name <cluster> --query 'aadProfile'",
        "az aks show --resource-group <rg> --name <cluster> --query 'securityProfile.workloadIdentity'",
      ],
      resources: ["ServiceAccount", "AzureIdentity", "AzureIdentityBinding"],
      notes: "AKS supports Workload Identity (preferred) and Pod Identity (deprecated). Ensure AAD integration is enabled for RBAC.",
    },
    gke: {
      summary: "Audit Workload Identity Federation configuration",
      commands: [
        "kubectl get sa -A -o json | jq '.items[] | select(.metadata.annotations[\"iam.gke.io/gcp-service-account\"])'",
        "gcloud container clusters describe <cluster> --format='value(workloadIdentityConfig)'",
        "gcloud iam service-accounts get-iam-policy <gsa>@<project>.iam.gserviceaccount.com",
      ],
      resources: ["ServiceAccount", "GCP Service Account"],
      notes: "GKE Workload Identity Federation binds KSAs to GSAs. Annotate the K8s SA with `iam.gke.io/gcp-service-account`.",
    },
    k8s: {
      summary: "Audit ServiceAccount permissions and token configuration",
      commands: [
        "kubectl get sa -A",
        "kubectl get clusterrolebindings -o json | jq '.items[] | select(.subjects[]?.kind==\"ServiceAccount\")'",
        "kubectl auth can-i --list --as=system:serviceaccount:<ns>:<sa>",
      ],
      resources: ["ServiceAccount", "ClusterRoleBinding", "RoleBinding"],
      notes: "Review RBAC bindings for each SA. Ensure `automountServiceAccountToken: false` where not needed.",
    },
  },

  auth_config: {
    openshift: {
      summary: "Manage OAuth identity providers (LDAP, GitHub, OIDC, HTPasswd)",
      commands: [
        "oc get oauth cluster -o yaml",
        "oc get oauthclient",
        "oc get identity",
      ],
      resources: ["OAuth", "OAuthClient", "Identity"],
      notes: "Configure identity providers in the OAuth cluster resource. Supports LDAP, GitHub, GitLab, Google, OpenID Connect, HTPasswd, and more.",
    },
    rosa: {
      summary: "Manage identity providers via rosa CLI",
      commands: [
        "rosa list idps --cluster=<id>",
        "rosa create idp --cluster=<id> --type=github --client-id=<id> --client-secret=<secret>",
      ],
      resources: ["OAuth", "OAuthClient"],
      notes: "ROSA manages identity providers through the `rosa` CLI or OCM console. Supports GitHub, Google, LDAP, OpenID, and HTPasswd.",
    },
    aro: {
      summary: "Manage OAuth providers and Azure AD integration",
      commands: [
        "oc get oauth cluster -o yaml",
        "az aro show --name <aro> --resource-group <rg> --query 'apiserverProfile'",
      ],
      resources: ["OAuth", "OAuthClient"],
      notes: "ARO supports OpenShift OAuth providers and can integrate with Azure AD for enterprise SSO.",
    },
    eks: {
      summary: "Manage aws-auth ConfigMap and OIDC identity providers",
      commands: [
        "kubectl get configmap aws-auth -n kube-system -o yaml",
        "eksctl get iamidentitymapping --cluster <name>",
        "aws eks describe-identity-provider-config --cluster-name <name> --identity-provider-config type=oidc,name=<name>",
      ],
      resources: ["ConfigMap (aws-auth)", "OIDC IdentityProviderConfig"],
      notes: "The aws-auth ConfigMap maps IAM roles/users to K8s RBAC. EKS also supports OIDC identity providers for cluster authentication.",
    },
    aks: {
      summary: "Manage Azure AD (Entra ID) integration for cluster authentication",
      commands: [
        "az aks show --resource-group <rg> --name <cluster> --query 'aadProfile'",
        "az aks update --resource-group <rg> --name <cluster> --enable-aad --aad-admin-group-object-ids <id>",
        "kubectl get clusterrolebindings -l azure.workload.identity/use=true",
      ],
      resources: ["AAD Profile", "ClusterRoleBinding"],
      notes: "AKS integrates with Azure AD (Entra ID) for authentication. Use `--enable-azure-rbac` for Azure RBAC for K8s authorization.",
    },
    gke: {
      summary: "Manage GCP IAM bindings for cluster access",
      commands: [
        "gcloud projects get-iam-policy <project> --filter='bindings.role:roles/container.*'",
        "gcloud container clusters describe <cluster> --format='value(masterAuth)'",
        "kubectl get clusterrolebindings",
      ],
      resources: ["IAM Policy", "ClusterRoleBinding"],
      notes: "GKE uses GCP IAM for authentication. Grant `roles/container.clusterViewer` or `roles/container.admin` at the project level.",
    },
    k8s: {
      summary: "Manage authentication via kubeconfig, OIDC, or certificates",
      commands: [
        "kubectl config view",
        "kubectl get clusterrolebindings",
        "kubectl create clusterrolebinding <name> --clusterrole=<role> --user=<user>",
      ],
      resources: ["ClusterRoleBinding", "RoleBinding"],
      notes: "Vanilla K8s supports X.509 certs, OIDC tokens, webhook tokens, and more. Configure via API server flags.",
    },
  },

  // ---- Scaling & Autoscaling ----
  node_autoscale: {
    openshift: {
      summary: "Configure MachineAutoscaler and ClusterAutoscaler resources",
      commands: [
        "oc get machineautoscaler -n openshift-machine-api",
        "oc get clusterautoscaler",
        "oc get machineset -n openshift-machine-api",
      ],
      resources: ["MachineAutoscaler", "ClusterAutoscaler", "MachineSet"],
      notes: "Create a MachineAutoscaler per MachineSet with min/max replicas. The ClusterAutoscaler must also be enabled.",
    },
    rosa: {
      summary: "Configure machine pool autoscaling via rosa CLI",
      commands: [
        "rosa list machinepools --cluster=<id>",
        "rosa edit machinepool --cluster=<id> <pool> --enable-autoscaling --min-replicas=<n> --max-replicas=<n>",
      ],
      resources: ["MachinePool"],
      notes: "ROSA manages autoscaling through machine pools. Use `rosa edit machinepool` to enable/configure autoscaling.",
    },
    aro: {
      summary: "Configure MachineAutoscaler and ClusterAutoscaler resources",
      commands: [
        "oc get machineautoscaler -n openshift-machine-api",
        "oc get clusterautoscaler",
        "oc apply -f machineautoscaler.yaml",
      ],
      resources: ["MachineAutoscaler", "ClusterAutoscaler", "MachineSet"],
      notes: "ARO uses the standard OpenShift Machine API for autoscaling.",
    },
    eks: {
      summary: "Use Karpenter provisioners or Cluster Autoscaler with managed node groups",
      commands: [
        "kubectl get provisioners.karpenter.sh  # Karpenter v1alpha",
        "kubectl get nodepools.karpenter.sh     # Karpenter v1beta",
        "kubectl get deployment cluster-autoscaler -n kube-system",
        "eksctl get nodegroup --cluster <name>",
      ],
      resources: ["Provisioner/NodePool (Karpenter)", "Deployment (cluster-autoscaler)"],
      notes: "Karpenter is recommended for EKS. It provisions nodes based on pod requirements without pre-defined node groups. Alternatively, use Cluster Autoscaler with ASG-based node groups.",
    },
    aks: {
      summary: "Configure AKS node pool autoscaler",
      commands: [
        "az aks nodepool update --resource-group <rg> --cluster-name <cluster> --name <pool> --enable-cluster-autoscaler --min-count <n> --max-count <n>",
        "az aks show --resource-group <rg> --name <cluster> --query 'agentPoolProfiles[].{name:name,min:minCount,max:maxCount,autoscale:enableAutoScaling}'",
      ],
      resources: ["Node Pool"],
      notes: "AKS has a built-in cluster autoscaler. Enable per node pool with min/max counts.",
    },
    gke: {
      summary: "Configure GKE cluster autoscaler or use Autopilot mode",
      commands: [
        "gcloud container clusters update <cluster> --enable-autoscaling --node-pool <pool> --min-nodes <n> --max-nodes <n>",
        "gcloud container clusters describe <cluster> --format='value(autoscaling)'",
      ],
      resources: ["Node Pool"],
      notes: "GKE supports per-node-pool autoscaling. GKE Autopilot clusters manage node scaling automatically.",
    },
    k8s: {
      summary: "Deploy Cluster Autoscaler or Karpenter",
      commands: [
        "kubectl get deployment cluster-autoscaler -n kube-system",
        "kubectl get pods -n kube-system -l app=cluster-autoscaler",
      ],
      resources: ["Deployment (cluster-autoscaler)"],
      notes: "Install Cluster Autoscaler and configure it for your infrastructure provider. Karpenter is also an option for supported providers.",
    },
  },

  scale_nodes: {
    openshift: {
      summary: "Scale MachineSets to adjust cluster node count",
      commands: [
        "oc get machineset -n openshift-machine-api",
        "oc scale machineset <name> --replicas=<n> -n openshift-machine-api",
      ],
      resources: ["MachineSet", "Machine"],
      notes: "Each MachineSet maps to an availability zone / instance type. Scale the appropriate MachineSet.",
    },
    rosa: {
      summary: "Scale ROSA machine pools",
      commands: [
        "rosa list machinepools --cluster=<id>",
        "rosa edit machinepool --cluster=<id> <pool> --replicas=<n>",
      ],
      resources: ["MachinePool"],
      notes: "Use the rosa CLI to scale machine pools. For autoscaled pools, adjust the min/max replicas.",
    },
    aro: {
      summary: "Scale MachineSets in ARO",
      commands: [
        "oc get machineset -n openshift-machine-api",
        "oc scale machineset <name> --replicas=<n> -n openshift-machine-api",
      ],
      resources: ["MachineSet", "Machine"],
      notes: "ARO uses the standard OpenShift Machine API. Scale MachineSets directly.",
    },
    eks: {
      summary: "Scale EKS managed node groups or Karpenter provisioners",
      commands: [
        "eksctl scale nodegroup --cluster=<name> --name=<ng> --nodes=<n>",
        "aws eks update-nodegroup-config --cluster-name <name> --nodegroup-name <ng> --scaling-config minSize=<n>,maxSize=<n>,desiredSize=<n>",
      ],
      resources: ["Managed Node Group", "Auto Scaling Group"],
      notes: "For Karpenter-managed nodes, adjust the NodePool limits or add resource constraints.",
    },
    aks: {
      summary: "Scale AKS node pools",
      commands: [
        "az aks nodepool scale --resource-group <rg> --cluster-name <cluster> --name <pool> --node-count <n>",
        "az aks nodepool list --resource-group <rg> --cluster-name <cluster> -o table",
      ],
      resources: ["Node Pool"],
      notes: "If autoscaling is enabled, update the min/max counts instead of setting a fixed count.",
    },
    gke: {
      summary: "Resize GKE node pools",
      commands: [
        "gcloud container clusters resize <cluster> --node-pool <pool> --num-nodes <n>",
        "gcloud container node-pools list --cluster <cluster>",
      ],
      resources: ["Node Pool"],
      notes: "For Autopilot clusters, node scaling is automatic. For Standard clusters, resize the node pool directly.",
    },
    k8s: {
      summary: "Manually scale cluster nodes using your provisioning tooling",
      commands: [
        "kubectl get nodes",
        "kubectl cordon <node>",
        "kubectl drain <node> --ignore-daemonsets --delete-emptydir-data",
      ],
      resources: ["Node"],
      notes: "Node scaling in vanilla K8s depends on your infrastructure (kubeadm, kops, Kubespray, etc.).",
    },
  },

  // ---- Upgrades ----
  cluster_upgrade: {
    openshift: {
      summary: "Upgrade via ClusterVersion resource and channel selection",
      commands: [
        "oc get clusterversion",
        "oc adm upgrade",
        "oc adm upgrade --to=<version>",
      ],
      resources: ["ClusterVersion"],
      notes: "OpenShift uses the ClusterVersion operator for coordinated upgrades. Select the appropriate update channel (stable, fast, eus).",
    },
    rosa: {
      summary: "Upgrade ROSA cluster via rosa CLI or OCM console",
      commands: [
        "rosa describe cluster --cluster=<id>",
        "rosa upgrade cluster --cluster=<id> --version=<version>",
        "rosa list upgrades --cluster=<id>",
      ],
      resources: ["ClusterVersion"],
      notes: "ROSA upgrades are managed through the rosa CLI or Red Hat Console. Scheduled maintenance windows are respected.",
    },
    aro: {
      summary: "Upgrade ARO cluster (managed by Azure and Red Hat jointly)",
      commands: [
        "oc get clusterversion",
        "oc adm upgrade",
        "az aro update --resource-group <rg> --name <aro>",
      ],
      resources: ["ClusterVersion"],
      notes: "ARO upgrades are coordinated between Azure and Red Hat. Check available upgrade paths in the Azure portal or via `oc adm upgrade`.",
    },
    eks: {
      summary: "Upgrade EKS control plane and node groups separately",
      commands: [
        "aws eks describe-cluster --name <cluster> --query 'cluster.version'",
        "aws eks update-cluster-version --name <cluster> --kubernetes-version <version>",
        "eksctl upgrade nodegroup --cluster=<name> --name=<ng> --kubernetes-version=<version>",
      ],
      resources: ["EKS Cluster", "Managed Node Group"],
      notes: "EKS upgrades the control plane and node groups independently. Upgrade the control plane first, then each node group. Only one minor version at a time.",
    },
    aks: {
      summary: "Upgrade AKS cluster using Azure CLI",
      commands: [
        "az aks get-upgrades --resource-group <rg> --name <cluster> -o table",
        "az aks upgrade --resource-group <rg> --name <cluster> --kubernetes-version <version>",
      ],
      resources: ["AKS Cluster"],
      notes: "AKS supports in-place upgrades. Use `az aks get-upgrades` to see available versions. Control plane and node pools can be upgraded together or separately.",
    },
    gke: {
      summary: "Upgrade GKE cluster and node pools via gcloud",
      commands: [
        "gcloud container clusters list --format='table(name,currentMasterVersion,currentNodeVersion)'",
        "gcloud container clusters upgrade <cluster> --master --cluster-version <version>",
        "gcloud container clusters upgrade <cluster> --node-pool <pool>",
      ],
      resources: ["GKE Cluster"],
      notes: "GKE supports release channels (rapid, regular, stable) for automatic upgrades. For manual upgrades, upgrade the control plane first.",
    },
    k8s: {
      summary: "Upgrade Kubernetes using kubeadm or your installation tool",
      commands: [
        "kubectl version --short",
        "kubeadm upgrade plan",
        "kubeadm upgrade apply <version>",
      ],
      resources: ["Node"],
      notes: "Follow the official kubeadm upgrade procedure: upgrade kubeadm, then control plane, then kubelets on each node. One minor version at a time.",
    },
  },

  addon_management: {
    openshift: {
      summary: "Manage cluster add-ons via OperatorHub and OLM",
      commands: [
        "oc get csv -A",
        "oc get subscriptions -A",
        "oc get catalogsources -n openshift-marketplace",
      ],
      resources: ["ClusterServiceVersion", "Subscription", "CatalogSource"],
      notes: "OpenShift uses Operator Lifecycle Manager (OLM) and OperatorHub for add-on management.",
    },
    rosa: {
      summary: "Manage add-ons via OperatorHub and ROSA managed add-ons",
      commands: [
        "rosa list addons --cluster=<id>",
        "rosa install addon --cluster=<id> <addon>",
        "oc get csv -A",
      ],
      resources: ["ClusterServiceVersion", "Subscription"],
      notes: "ROSA provides managed add-ons (like cluster logging, cluster autoscaler) alongside standard OperatorHub.",
    },
    aro: {
      summary: "Manage add-ons via OperatorHub",
      commands: [
        "oc get csv -A",
        "oc get subscriptions -A",
      ],
      resources: ["ClusterServiceVersion", "Subscription"],
      notes: "ARO uses OperatorHub like standard OpenShift. Some operators may require Azure-specific configuration.",
    },
    eks: {
      summary: "Manage EKS add-ons (VPC CNI, CoreDNS, kube-proxy, EBS CSI, etc.)",
      commands: [
        "aws eks list-addons --cluster-name <name>",
        "aws eks describe-addon --cluster-name <name> --addon-name <addon>",
        "eksctl create addon --cluster <name> --name <addon> --version <ver>",
      ],
      resources: ["EKS Add-on"],
      notes: "EKS manages core add-ons (vpc-cni, coredns, kube-proxy) and optional ones (ebs-csi-driver, adot). Use `aws eks describe-addon-versions` to find available versions.",
    },
    aks: {
      summary: "Manage AKS extensions and add-ons",
      commands: [
        "az aks addon list --resource-group <rg> --name <cluster>",
        "az aks addon enable --resource-group <rg> --name <cluster> --addon <addon>",
        "az k8s-extension list --resource-group <rg> --cluster-name <cluster> --cluster-type managedClusters",
      ],
      resources: ["AKS Add-on", "AKS Extension"],
      notes: "AKS provides built-in add-ons (monitoring, policy, ingress) and extensions. Some add-ons are enabled at creation only.",
    },
    gke: {
      summary: "Manage GKE add-ons and features",
      commands: [
        "gcloud container clusters describe <cluster> --format='value(addonsConfig)'",
        "gcloud container clusters update <cluster> --update-addons=<addon>=ENABLED",
      ],
      resources: ["GKE Add-on"],
      notes: "GKE add-ons include HttpLoadBalancing, HorizontalPodAutoscaling, NetworkPolicy, GcePersistentDiskCsiDriver, and more.",
    },
    k8s: {
      summary: "Manage add-ons via Helm, manifests, or custom operators",
      commands: [
        "helm list -A",
        "kubectl get pods -n kube-system",
        "kubectl apply -f https://raw.githubusercontent.com/<addon>/deploy.yaml",
      ],
      resources: ["Deployment", "DaemonSet"],
      notes: "Vanilla K8s has no built-in add-on manager. Use Helm charts, kustomize, or GitOps tools to manage add-ons.",
    },
  },

  // ---- Monitoring ----
  check_monitoring: {
    openshift: {
      summary: "Check the OpenShift Monitoring stack (Prometheus, Alertmanager, Grafana)",
      commands: [
        "oc get pods -n openshift-monitoring",
        "oc get prometheusrule -A",
        "oc get servicemonitor -A",
        "oc -n openshift-monitoring get routes",
      ],
      resources: ["Prometheus", "PrometheusRule", "ServiceMonitor", "Alertmanager"],
      notes: "OpenShift includes a pre-configured monitoring stack. User workload monitoring can be enabled via the cluster-monitoring-config ConfigMap.",
    },
    rosa: {
      summary: "Check the OpenShift Monitoring stack",
      commands: [
        "oc get pods -n openshift-monitoring",
        "oc get prometheusrule -A",
        "oc get servicemonitor -A",
      ],
      resources: ["Prometheus", "PrometheusRule", "ServiceMonitor"],
      notes: "ROSA includes the full OpenShift monitoring stack. Enable user workload monitoring for application metrics.",
    },
    aro: {
      summary: "Check the OpenShift Monitoring stack and Azure Monitor integration",
      commands: [
        "oc get pods -n openshift-monitoring",
        "oc get prometheusrule -A",
        "az monitor metrics list --resource <aro-resource-id>",
      ],
      resources: ["Prometheus", "PrometheusRule", "ServiceMonitor"],
      notes: "ARO includes the OpenShift monitoring stack and can additionally integrate with Azure Monitor.",
    },
    eks: {
      summary: "Check CloudWatch Container Insights and Prometheus (if installed)",
      commands: [
        "kubectl get pods -n amazon-cloudwatch",
        "kubectl get pods -n prometheus -l app=prometheus",
        "aws cloudwatch list-metrics --namespace ContainerInsights --dimensions Name=ClusterName,Value=<cluster>",
      ],
      resources: ["DaemonSet (cloudwatch-agent)", "Deployment (prometheus)"],
      notes: "EKS uses CloudWatch Container Insights for native monitoring. Install the CloudWatch agent DaemonSet and Fluent Bit for full observability. Amazon Managed Prometheus is available as a managed option.",
    },
    aks: {
      summary: "Check Azure Monitor for containers (Container Insights)",
      commands: [
        "kubectl get pods -n kube-system -l component=oms-agent",
        "az aks show --resource-group <rg> --name <cluster> --query 'addonProfiles.omsagent'",
        "az monitor log-analytics query --workspace <id> --analytics-query 'KubePodInventory | take 10'",
      ],
      resources: ["DaemonSet (omsagent)", "Azure Monitor Workspace"],
      notes: "AKS integrates with Azure Monitor Container Insights. Enable the monitoring add-on for automatic metric and log collection.",
    },
    gke: {
      summary: "Check Google Cloud Operations suite (Cloud Monitoring)",
      commands: [
        "kubectl get pods -n gke-managed-system",
        "gcloud container clusters describe <cluster> --format='value(loggingConfig,monitoringConfig)'",
      ],
      resources: ["GKE Managed System Pods"],
      notes: "GKE integrates with Google Cloud Operations (formerly Stackdriver) by default. System and workload metrics are collected automatically.",
    },
    k8s: {
      summary: "Check metrics-server and any installed monitoring stack",
      commands: [
        "kubectl get deployment metrics-server -n kube-system",
        "kubectl top nodes",
        "kubectl get pods -n monitoring",
      ],
      resources: ["Deployment (metrics-server)"],
      notes: "Vanilla K8s requires manual setup of monitoring. Common stacks: kube-prometheus-stack (Helm), Prometheus Operator, or third-party solutions.",
    },
  },

  check_logging: {
    openshift: {
      summary: "Check the Cluster Logging Operator (Elasticsearch/Loki, Fluentd/Vector)",
      commands: [
        "oc get pods -n openshift-logging",
        "oc get clusterlogging instance -n openshift-logging -o yaml",
        "oc get clusterlogforwarder -n openshift-logging",
      ],
      resources: ["ClusterLogging", "ClusterLogForwarder"],
      notes: "Install the Cluster Logging Operator via OperatorHub. Supports Elasticsearch, Loki, or external log stores as backends.",
    },
    rosa: {
      summary: "Check the Cluster Logging Operator",
      commands: [
        "oc get pods -n openshift-logging",
        "oc get clusterlogging instance -n openshift-logging -o yaml",
      ],
      resources: ["ClusterLogging", "ClusterLogForwarder"],
      notes: "ROSA supports the OpenShift Cluster Logging Operator. Configure ClusterLogForwarder to send logs to CloudWatch or other sinks.",
    },
    aro: {
      summary: "Check the Cluster Logging Operator and Azure Monitor Logs",
      commands: [
        "oc get pods -n openshift-logging",
        "oc get clusterlogging instance -n openshift-logging -o yaml",
      ],
      resources: ["ClusterLogging", "ClusterLogForwarder"],
      notes: "ARO supports the OpenShift Cluster Logging Operator. Logs can be forwarded to Azure Monitor or Azure Log Analytics.",
    },
    eks: {
      summary: "Check CloudWatch Logs and Fluent Bit / Fluentd log collection",
      commands: [
        "kubectl get pods -n amazon-cloudwatch -l k8s-app=fluent-bit",
        "kubectl get configmap fluent-bit-config -n amazon-cloudwatch -o yaml",
        "aws logs describe-log-groups --log-group-name-prefix /aws/containerinsights/<cluster>",
      ],
      resources: ["DaemonSet (fluent-bit)", "ConfigMap (fluent-bit-config)"],
      notes: "EKS uses Fluent Bit to ship logs to CloudWatch Logs. Install the aws-for-fluent-bit DaemonSet for log collection.",
    },
    aks: {
      summary: "Check Azure Monitor Logs (Log Analytics) for container logs",
      commands: [
        "az aks show --resource-group <rg> --name <cluster> --query 'addonProfiles.omsagent'",
        "kubectl get pods -n kube-system -l component=oms-agent",
        "az monitor log-analytics query --workspace <id> --analytics-query 'ContainerLog | take 10'",
      ],
      resources: ["DaemonSet (omsagent)", "Log Analytics Workspace"],
      notes: "AKS Container Insights collects stdout/stderr logs automatically when the monitoring add-on is enabled.",
    },
    gke: {
      summary: "Check Cloud Logging integration",
      commands: [
        "gcloud container clusters describe <cluster> --format='value(loggingConfig)'",
        "gcloud logging read 'resource.type=\"k8s_container\" AND resource.labels.cluster_name=\"<cluster>\"' --limit 10",
      ],
      resources: ["Cloud Logging"],
      notes: "GKE sends logs to Cloud Logging by default. Use log-based metrics and log sinks for advanced workflows.",
    },
    k8s: {
      summary: "Check for installed log collectors (Fluentd, Fluent Bit, Loki, etc.)",
      commands: [
        "kubectl get pods -n logging",
        "kubectl get daemonsets -A -l app.kubernetes.io/component=log-collector",
      ],
      resources: ["DaemonSet"],
      notes: "Vanilla K8s has no built-in log aggregation. Common solutions: EFK stack (Elasticsearch, Fluentd, Kibana), Loki + Promtail, or cloud-specific agents.",
    },
  },

  // ---- Storage ----
  storage_config: {
    openshift: {
      summary: "Check OpenShift Data Foundation (ODF) / OpenShift Container Storage (OCS)",
      commands: [
        "oc get storagecluster -n openshift-storage",
        "oc get cephcluster -n openshift-storage",
        "oc get storageclass",
        "oc get pvc -A",
      ],
      resources: ["StorageCluster", "CephCluster", "StorageClass"],
      notes: "ODF provides Ceph-based storage (block, file, object). For non-ODF setups, check the CSI drivers for your storage backend.",
    },
    rosa: {
      summary: "Check storage classes and EBS CSI driver",
      commands: [
        "oc get storageclass",
        "oc get pvc -A",
        "oc get csidrivers",
      ],
      resources: ["StorageClass", "CSIDriver"],
      notes: "ROSA uses AWS EBS CSI driver by default (gp3). ODF can be installed via OperatorHub for additional storage capabilities.",
    },
    aro: {
      summary: "Check storage classes and Azure Disk/File CSI drivers",
      commands: [
        "oc get storageclass",
        "oc get pvc -A",
        "oc get csidrivers",
      ],
      resources: ["StorageClass", "CSIDriver"],
      notes: "ARO uses Azure Disk and Azure File CSI drivers. The default storage class is typically managed-premium (Azure Managed Disk).",
    },
    eks: {
      summary: "Check Amazon EBS CSI driver and EFS CSI driver",
      commands: [
        "kubectl get storageclass",
        "kubectl get csidrivers",
        "aws eks describe-addon --cluster-name <name> --addon-name aws-ebs-csi-driver",
        "kubectl get pvc -A",
      ],
      resources: ["StorageClass", "CSIDriver", "EKS Add-on"],
      notes: "Install the EBS CSI driver as an EKS add-on. Use EFS CSI driver for shared (ReadWriteMany) storage. Ensure the IRSA role has proper permissions.",
    },
    aks: {
      summary: "Check Azure Disk and Azure File CSI drivers",
      commands: [
        "kubectl get storageclass",
        "kubectl get csidrivers",
        "az aks show --resource-group <rg> --name <cluster> --query 'storageProfile'",
        "kubectl get pvc -A",
      ],
      resources: ["StorageClass", "CSIDriver"],
      notes: "AKS includes Azure Disk CSI and Azure File CSI drivers by default. Use managed-csi for block storage and azurefile-csi for shared file storage.",
    },
    gke: {
      summary: "Check GCE Persistent Disk CSI driver and Filestore CSI driver",
      commands: [
        "kubectl get storageclass",
        "kubectl get csidrivers",
        "gcloud container clusters describe <cluster> --format='value(addonsConfig.gcePersistentDiskCsiDriverConfig)'",
        "kubectl get pvc -A",
      ],
      resources: ["StorageClass", "CSIDriver"],
      notes: "GKE includes the GCE PD CSI driver by default. Use Filestore CSI driver for NFS-based ReadWriteMany volumes.",
    },
    k8s: {
      summary: "Check storage classes and installed CSI drivers",
      commands: [
        "kubectl get storageclass",
        "kubectl get csidrivers",
        "kubectl get pvc -A",
      ],
      resources: ["StorageClass", "CSIDriver"],
      notes: "Storage depends on your infrastructure. Common CSI drivers: local-path, NFS, Longhorn, Rook-Ceph, OpenEBS.",
    },
  },

  // ---- Security ----
  pod_security: {
    openshift: {
      summary: "Manage SecurityContextConstraints (SCC) — OpenShift's pod security mechanism",
      commands: [
        "oc get scc",
        "oc describe scc restricted-v2",
        "oc adm policy who-can use scc privileged",
        "oc adm policy add-scc-to-user <scc> -z <sa> -n <ns>",
      ],
      resources: ["SecurityContextConstraint"],
      notes: "OpenShift uses SCCs instead of Pod Security Standards. The default `restricted-v2` SCC is equivalent to the PSS restricted profile. Avoid granting `privileged` or `anyuid` unless necessary.",
    },
    rosa: {
      summary: "Manage SecurityContextConstraints (SCC)",
      commands: [
        "oc get scc",
        "oc describe scc restricted-v2",
        "oc adm policy who-can use scc privileged",
      ],
      resources: ["SecurityContextConstraint"],
      notes: "ROSA uses SCCs like standard OpenShift. SRE-managed SCCs should not be modified.",
    },
    aro: {
      summary: "Manage SecurityContextConstraints (SCC)",
      commands: [
        "oc get scc",
        "oc describe scc restricted-v2",
        "oc adm policy who-can use scc privileged",
      ],
      resources: ["SecurityContextConstraint"],
      notes: "ARO uses SCCs like standard OpenShift. Some SCCs are managed by the ARO service.",
    },
    eks: {
      summary: "Use Pod Security Standards (PSS) via Pod Security Admission",
      commands: [
        "kubectl label namespace <ns> pod-security.kubernetes.io/enforce=restricted",
        "kubectl get namespaces -L pod-security.kubernetes.io/enforce",
      ],
      resources: ["Namespace (labels)", "Pod Security Admission"],
      notes: "EKS supports Pod Security Standards via Pod Security Admission (PSA). Apply enforce/audit/warn labels to namespaces. Consider policy engines (OPA Gatekeeper, Kyverno) for advanced policies.",
    },
    aks: {
      summary: "Use Pod Security Standards (PSS) via Pod Security Admission",
      commands: [
        "kubectl label namespace <ns> pod-security.kubernetes.io/enforce=restricted",
        "kubectl get namespaces -L pod-security.kubernetes.io/enforce",
        "az aks show --resource-group <rg> --name <cluster> --query 'securityProfile'",
      ],
      resources: ["Namespace (labels)", "Pod Security Admission"],
      notes: "AKS supports PSA and also offers Azure Policy for Kubernetes (Gatekeeper-based) for additional policy enforcement.",
    },
    gke: {
      summary: "Use Pod Security Standards (PSS) via Pod Security Admission",
      commands: [
        "kubectl label namespace <ns> pod-security.kubernetes.io/enforce=restricted",
        "kubectl get namespaces -L pod-security.kubernetes.io/enforce",
      ],
      resources: ["Namespace (labels)", "Pod Security Admission"],
      notes: "GKE supports PSA. GKE Autopilot enforces baseline security restrictions by default. For GKE Standard, use Policy Controller or Gatekeeper.",
    },
    k8s: {
      summary: "Use Pod Security Standards (PSS) via Pod Security Admission",
      commands: [
        "kubectl label namespace <ns> pod-security.kubernetes.io/enforce=restricted",
        "kubectl get namespaces -L pod-security.kubernetes.io/enforce",
      ],
      resources: ["Namespace (labels)", "Pod Security Admission"],
      notes: "PSA is built into K8s 1.25+. For older clusters, use PodSecurityPolicy (deprecated) or a policy engine like OPA Gatekeeper or Kyverno.",
    },
  },

  image_scanning: {
    openshift: {
      summary: "Use Red Hat Advanced Cluster Security (ACS) or Quay image scanning",
      commands: [
        "oc get pods -n stackrox",
        "oc get pods -n quay-enterprise",
        "roxctl image check --image=<image>",
        "roxctl image scan --image=<image>",
      ],
      resources: ["ACS Central", "Quay"],
      notes: "ACS (StackRox) provides build-time and runtime image scanning. Quay includes Clair-based vulnerability scanning for stored images.",
    },
    rosa: {
      summary: "Use Red Hat Advanced Cluster Security (ACS) or Quay image scanning",
      commands: [
        "oc get pods -n stackrox",
        "roxctl image check --image=<image>",
      ],
      resources: ["ACS Central"],
      notes: "Install ACS via OperatorHub on ROSA for image scanning and runtime security.",
    },
    aro: {
      summary: "Use Red Hat ACS, Quay, or Microsoft Defender for Containers",
      commands: [
        "oc get pods -n stackrox",
        "az security assessment list --query \"[?contains(resourceDetails.source, 'aro')]\"",
      ],
      resources: ["ACS Central", "Defender for Containers"],
      notes: "ARO can use both OpenShift-native (ACS/Quay) and Azure-native (Defender for Containers) scanning.",
    },
    eks: {
      summary: "Use Amazon ECR image scanning (basic or enhanced with Inspector)",
      commands: [
        "aws ecr describe-image-scan-findings --repository-name <repo> --image-id imageTag=<tag>",
        "aws ecr start-image-scan --repository-name <repo> --image-id imageTag=<tag>",
        "aws ecr put-image-scanning-configuration --repository-name <repo> --image-scanning-configuration scanOnPush=true",
      ],
      resources: ["ECR Repository"],
      notes: "ECR supports basic scanning (Clair) and enhanced scanning (Amazon Inspector). Enable scan-on-push for continuous scanning.",
    },
    aks: {
      summary: "Use Microsoft Defender for Containers for image vulnerability scanning",
      commands: [
        "az security assessment list --query \"[?resourceDetails.source == 'Azure']\"",
        "az acr repository show-manifests --name <acr> --repository <repo>",
      ],
      resources: ["Defender for Containers", "Azure Container Registry"],
      notes: "Defender for Containers scans images in ACR and provides runtime vulnerability assessments for running images.",
    },
    gke: {
      summary: "Use Artifact Analysis (Container Analysis) for image scanning",
      commands: [
        "gcloud artifacts docker images list <repo> --show-occurrences",
        "gcloud artifacts vulnerabilities list --format=json",
      ],
      resources: ["Artifact Registry", "Container Analysis"],
      notes: "GKE Artifact Analysis provides on-push and continuous vulnerability scanning. Enable Binary Authorization to enforce image policies.",
    },
    k8s: {
      summary: "Use a third-party image scanner (Trivy, Grype, Snyk, etc.)",
      commands: [
        "trivy image <image>",
        "grype <image>",
      ],
      resources: [],
      notes: "No built-in image scanning. Integrate Trivy, Grype, or Snyk into your CI/CD pipeline and admission webhooks.",
    },
  },

  secret_management: {
    openshift: {
      summary: "Use Sealed Secrets, External Secrets Operator, or HashiCorp Vault",
      commands: [
        "oc get sealedsecrets -A",
        "oc get externalsecret -A",
        "oc get pods -n vault",
      ],
      resources: ["SealedSecret", "ExternalSecret"],
      notes: "OpenShift has no built-in external secrets integration. Install Sealed Secrets controller or External Secrets Operator via OperatorHub. Vault is also commonly used.",
    },
    rosa: {
      summary: "Use Sealed Secrets, External Secrets Operator, or AWS Secrets Manager",
      commands: [
        "oc get externalsecret -A",
        "aws secretsmanager list-secrets",
      ],
      resources: ["ExternalSecret"],
      notes: "ROSA clusters on AWS can use External Secrets Operator to sync from AWS Secrets Manager or Parameter Store.",
    },
    aro: {
      summary: "Use Azure Key Vault with the Secrets Store CSI Driver",
      commands: [
        "kubectl get secretproviderclass -A",
        "az keyvault list",
        "kubectl get pods -n kube-system -l app=secrets-store-csi-driver",
      ],
      resources: ["SecretProviderClass"],
      notes: "Use the Azure Key Vault Provider for Secrets Store CSI Driver to mount secrets directly into pods.",
    },
    eks: {
      summary: "Use AWS Secrets Manager with External Secrets Operator or Secrets Store CSI Driver",
      commands: [
        "kubectl get externalsecret -A",
        "kubectl get secretproviderclass -A",
        "aws secretsmanager list-secrets",
      ],
      resources: ["ExternalSecret", "SecretProviderClass"],
      notes: "Use the AWS Secrets and Configuration Provider (ASCP) with the Secrets Store CSI Driver, or External Secrets Operator to sync secrets from AWS Secrets Manager / Parameter Store.",
    },
    aks: {
      summary: "Use Azure Key Vault with the Secrets Store CSI Driver",
      commands: [
        "kubectl get secretproviderclass -A",
        "az keyvault list",
        "az aks show --resource-group <rg> --name <cluster> --query 'addonProfiles.azureKeyvaultSecretsProvider'",
      ],
      resources: ["SecretProviderClass"],
      notes: "AKS has a built-in add-on for the Azure Key Vault Provider. Enable it with `az aks addon enable --addon azure-keyvault-secrets-provider`.",
    },
    gke: {
      summary: "Use Google Secret Manager with External Secrets Operator or Secrets Store CSI Driver",
      commands: [
        "kubectl get externalsecret -A",
        "kubectl get secretproviderclass -A",
        "gcloud secrets list",
      ],
      resources: ["ExternalSecret", "SecretProviderClass"],
      notes: "Use the GCP provider for Secrets Store CSI Driver or External Secrets Operator to sync from Google Secret Manager.",
    },
    k8s: {
      summary: "Use Sealed Secrets, External Secrets Operator, or HashiCorp Vault",
      commands: [
        "kubectl get sealedsecrets -A",
        "kubectl get externalsecret -A",
        "kubectl get pods -n vault",
      ],
      resources: ["SealedSecret", "ExternalSecret"],
      notes: "Vanilla K8s Secrets are base64-encoded, not encrypted at rest by default. Use etcd encryption, Sealed Secrets, or an external secrets manager for production.",
    },
  },
};

// ---------------------------------------------------------------------------
// Guidance text generators for prompt injection
// ---------------------------------------------------------------------------

const GUIDANCE_TEMPLATES = {
  expose_service: {
    openshift: "Use OpenShift Routes (`oc create route edge`) to expose services. Routes support edge, passthrough, and re-encrypt TLS termination natively.",
    rosa: "Use OpenShift Routes to expose services. ROSA clusters use AWS NLB/CLB for the router by default.",
    aro: "Use OpenShift Routes to expose services. ARO integrates with Azure Load Balancer for external traffic.",
    eks: "Use AWS ALB Ingress Controller with `kubernetes.io/ingress.class: alb` annotation. Set `alb.ingress.kubernetes.io/scheme: internet-facing` for public access.",
    aks: "Use Azure Load Balancer (via LoadBalancer Service) or AGIC (Application Gateway Ingress Controller) for exposing services.",
    gke: "Use Gateway API with GKE Gateway Controller or GKE Ingress (creates a Google Cloud Load Balancer). Annotate with `cloud.google.com/neg` for container-native LB.",
    k8s: "Create an Ingress resource (requires an Ingress controller) or expose via NodePort/LoadBalancer Service.",
  },
  check_ingress: {
    openshift: "Inspect Routes with `oc get routes -A`. Check the Admitted condition and canonical hostname.",
    rosa: "Inspect Routes with `oc get routes -A`. Verify AWS NLB health for external access.",
    aro: "Inspect Routes with `oc get routes -A`. Verify Azure LB health for external access.",
    eks: "Check ALB Ingress resources with `kubectl get ingress -A`. Verify target group health via AWS CLI.",
    aks: "Check LoadBalancer Services and Ingress with `kubectl get svc,ingress -A`. Verify Azure LB backend pools.",
    gke: "Check Ingress/Gateway resources with `kubectl get ingress,gateway -A`. Verify backend health in GCP Console.",
    k8s: "Check Ingress resources with `kubectl get ingress -A`. Ensure the Ingress controller pods are healthy.",
  },
  network_policy: {
    openshift: "OpenShift supports both NetworkPolicy and EgressNetworkPolicy. OVN-Kubernetes and OpenShift SDN enforce these natively.",
    rosa: "ROSA uses OVN-Kubernetes. Both NetworkPolicy and EgressNetworkPolicy are supported.",
    aro: "ARO supports NetworkPolicy and EgressNetworkPolicy via OpenShift SDN or OVN-Kubernetes.",
    eks: "The default VPC CNI does NOT enforce NetworkPolicy. Enable network policy support in VPC CNI (v1.14+) or install Calico.",
    aks: "AKS supports NetworkPolicy via Azure NPM or Calico (must be enabled at cluster creation).",
    gke: "GKE Dataplane V2 enforces NetworkPolicy natively. For Standard clusters, enable the network policy add-on.",
    k8s: "NetworkPolicy enforcement depends on your CNI plugin (Calico, Cilium, Weave Net). Verify your CNI supports it.",
  },
  check_sa_security: {
    openshift: "Audit SCCs with `oc get scc` and check OAuth providers. OpenShift uses SCCs instead of PSS for pod security.",
    rosa: "Audit SCCs with `oc get scc`. Use `rosa list idps` to check identity provider configuration.",
    aro: "Audit SCCs with `oc get scc`. Check Azure AD integration via `az aro show`.",
    eks: "Check IRSA (IAM Roles for Service Accounts) configuration. Annotate ServiceAccounts with `eks.amazonaws.com/role-arn`.",
    aks: "Check Workload Identity and AAD integration. Annotate ServiceAccounts with `azure.workload.identity/client-id`.",
    gke: "Check Workload Identity Federation. Annotate ServiceAccounts with `iam.gke.io/gcp-service-account`.",
    k8s: "Review RBAC bindings for ServiceAccounts. Use `kubectl auth can-i --list --as=system:serviceaccount:<ns>:<sa>`.",
  },
  auth_config: {
    openshift: "Configure identity providers in the OAuth cluster resource (`oc get oauth cluster -o yaml`). Supports LDAP, OIDC, GitHub, HTPasswd.",
    rosa: "Manage identity providers via `rosa list idps` / `rosa create idp`. Supports GitHub, Google, LDAP, OpenID, HTPasswd.",
    aro: "Configure OAuth providers and Azure AD integration. ARO supports standard OpenShift OAuth mechanisms.",
    eks: "Authentication is managed via the aws-auth ConfigMap in kube-system. Map IAM roles/users to K8s RBAC subjects.",
    aks: "Authentication via Azure AD (Entra ID). Use `az aks update --enable-aad` and `--enable-azure-rbac` for full AAD integration.",
    gke: "Authentication via GCP IAM. Grant `roles/container.*` roles at the project or cluster level.",
    k8s: "Configure authentication via API server flags (OIDC, webhook, certificates). Manage RBAC bindings for authorization.",
  },
  node_autoscale: {
    openshift: "Use MachineAutoscaler + ClusterAutoscaler resources. Create a MachineAutoscaler per MachineSet with min/max replicas.",
    rosa: "Configure autoscaling via `rosa edit machinepool --enable-autoscaling --min-replicas=<n> --max-replicas=<n>`.",
    aro: "Use MachineAutoscaler + ClusterAutoscaler resources via the OpenShift Machine API.",
    eks: "Use Karpenter provisioners (recommended) or Cluster Autoscaler with managed node groups. Karpenter scales based on pod requirements.",
    aks: "Enable per-node-pool autoscaling with `az aks nodepool update --enable-cluster-autoscaler --min-count <n> --max-count <n>`.",
    gke: "Configure per-node-pool autoscaling or use GKE Autopilot for fully managed node scaling.",
    k8s: "Deploy Cluster Autoscaler configured for your infrastructure provider.",
  },
  scale_nodes: {
    openshift: "Scale MachineSets with `oc scale machineset <name> --replicas=<n> -n openshift-machine-api`.",
    rosa: "Scale machine pools with `rosa edit machinepool --cluster=<id> <pool> --replicas=<n>`.",
    aro: "Scale MachineSets with `oc scale machineset <name> --replicas=<n> -n openshift-machine-api`.",
    eks: "Scale node groups with `eksctl scale nodegroup --cluster=<name> --name=<ng> --nodes=<n>` or update ASG desired capacity.",
    aks: "Scale node pools with `az aks nodepool scale --node-count <n>`.",
    gke: "Resize node pools with `gcloud container clusters resize <cluster> --node-pool <pool> --num-nodes <n>`.",
    k8s: "Manually scale nodes using your provisioning tool (kubeadm, kops, Kubespray, Terraform, etc.).",
  },
  cluster_upgrade: {
    openshift: "Upgrade via `oc adm upgrade --to=<version>`. Select the appropriate channel (stable, fast, eus).",
    rosa: "Upgrade via `rosa upgrade cluster --cluster=<id> --version=<version>`. Check available versions with `rosa list upgrades`.",
    aro: "Upgrades are coordinated between Azure and Red Hat. Use `oc adm upgrade` or the Azure portal.",
    eks: "Upgrade control plane first, then node groups. One minor version at a time. Use `aws eks update-cluster-version`.",
    aks: "Upgrade with `az aks upgrade --kubernetes-version <version>`. Check available versions with `az aks get-upgrades`.",
    gke: "Upgrade via `gcloud container clusters upgrade`. Use release channels for automatic upgrades.",
    k8s: "Upgrade using kubeadm: `kubeadm upgrade plan` then `kubeadm upgrade apply`. One minor version at a time.",
  },
  addon_management: {
    openshift: "Manage add-ons via OperatorHub and OLM. Use `oc get csv -A` to see installed operators.",
    rosa: "Use `rosa list addons` for managed add-ons and OperatorHub for additional operators.",
    aro: "Manage add-ons via OperatorHub. Some operators may need Azure-specific configuration.",
    eks: "Manage EKS add-ons with `aws eks list-addons` / `eksctl create addon`. Core add-ons: vpc-cni, coredns, kube-proxy.",
    aks: "Manage AKS add-ons with `az aks addon list` / `az aks addon enable`. Extensions for additional capabilities.",
    gke: "Manage GKE add-ons via `gcloud container clusters update --update-addons`.",
    k8s: "Use Helm, kustomize, or GitOps tools to manage add-ons. No built-in add-on manager.",
  },
  check_monitoring: {
    openshift: "Check the built-in OpenShift Monitoring stack in `openshift-monitoring` namespace. Includes Prometheus, Alertmanager, and Grafana.",
    rosa: "Check the OpenShift Monitoring stack in `openshift-monitoring`. Enable user workload monitoring for app metrics.",
    aro: "Check the OpenShift Monitoring stack and optionally integrate with Azure Monitor for cross-service visibility.",
    eks: "Use CloudWatch Container Insights for monitoring. Install the CloudWatch agent DaemonSet and Fluent Bit.",
    aks: "Use Azure Monitor Container Insights. Enable the monitoring add-on for automatic metric collection.",
    gke: "GKE integrates with Google Cloud Operations (Monitoring) by default. Check system metrics in the GCP Console.",
    k8s: "Install a monitoring stack (kube-prometheus-stack via Helm is recommended). Ensure metrics-server is deployed.",
  },
  check_logging: {
    openshift: "Use the Cluster Logging Operator (installed via OperatorHub). Supports Elasticsearch, Loki, or external log backends.",
    rosa: "Use the Cluster Logging Operator. Configure ClusterLogForwarder to ship logs to CloudWatch or other sinks.",
    aro: "Use the Cluster Logging Operator. Logs can be forwarded to Azure Monitor or Azure Log Analytics.",
    eks: "Use CloudWatch Logs with Fluent Bit. Install the aws-for-fluent-bit DaemonSet for log collection.",
    aks: "Azure Monitor Container Insights collects container logs automatically when the monitoring add-on is enabled.",
    gke: "GKE sends container logs to Cloud Logging by default. Use log-based metrics for alerting.",
    k8s: "Install a log collector (Fluent Bit, Fluentd, Promtail). No built-in log aggregation.",
  },
  storage_config: {
    openshift: "Check for ODF/OCS with `oc get storagecluster -n openshift-storage`. Check `oc get storageclass` for available storage classes.",
    rosa: "ROSA uses AWS EBS CSI driver by default (gp3). Install ODF via OperatorHub for advanced storage.",
    aro: "ARO uses Azure Disk and Azure File CSI drivers. Default storage class is typically managed-premium.",
    eks: "Install the EBS CSI driver as an EKS add-on. Use EFS CSI driver for ReadWriteMany workloads.",
    aks: "AKS includes Azure Disk CSI and Azure File CSI by default. Use managed-csi for block, azurefile-csi for shared storage.",
    gke: "GKE includes the GCE PD CSI driver. Use Filestore CSI for NFS-based ReadWriteMany volumes.",
    k8s: "Check available CSI drivers and storage classes. Common options: local-path, NFS, Longhorn, Rook-Ceph.",
  },
  pod_security: {
    openshift: "OpenShift uses SecurityContextConstraints (SCCs). Default `restricted-v2` is equivalent to PSS restricted. Audit with `oc get scc`.",
    rosa: "ROSA uses SCCs like standard OpenShift. SRE-managed SCCs should not be modified.",
    aro: "ARO uses SCCs like standard OpenShift. Some SCCs are managed by the ARO service.",
    eks: "Use Pod Security Standards via Pod Security Admission. Label namespaces with `pod-security.kubernetes.io/enforce=restricted`.",
    aks: "Use PSA labels and/or Azure Policy for Kubernetes (Gatekeeper-based) for pod security enforcement.",
    gke: "Use PSA labels. GKE Autopilot enforces baseline restrictions by default. Use Policy Controller for advanced rules.",
    k8s: "Use Pod Security Admission (K8s 1.25+). Label namespaces with appropriate PSS levels (restricted, baseline, privileged).",
  },
  image_scanning: {
    openshift: "Use Red Hat ACS (StackRox) for build-time and runtime scanning, or Quay with Clair for registry scanning.",
    rosa: "Install ACS via OperatorHub for image scanning. ECR scanning is also available for images stored in AWS.",
    aro: "Use ACS, Quay, or Microsoft Defender for Containers for image vulnerability scanning.",
    eks: "Use ECR image scanning (basic or enhanced with Amazon Inspector). Enable scan-on-push for continuous scanning.",
    aks: "Use Microsoft Defender for Containers for image scanning in ACR and runtime vulnerability assessment.",
    gke: "Use Artifact Analysis for vulnerability scanning. Enable Binary Authorization to enforce image policies.",
    k8s: "Integrate a third-party scanner (Trivy, Grype, Snyk) into your CI/CD pipeline and admission webhooks.",
  },
  secret_management: {
    openshift: "Use Sealed Secrets or External Secrets Operator (via OperatorHub) to manage secrets. Vault is also commonly used.",
    rosa: "Use External Secrets Operator to sync from AWS Secrets Manager or Parameter Store.",
    aro: "Use the Azure Key Vault Provider for Secrets Store CSI Driver to mount secrets into pods.",
    eks: "Use AWS Secrets Manager with External Secrets Operator or the ASCP (AWS Secrets and Configuration Provider).",
    aks: "Use Azure Key Vault with the Secrets Store CSI Driver add-on (`az aks addon enable --addon azure-keyvault-secrets-provider`).",
    gke: "Use Google Secret Manager with External Secrets Operator or the GCP Secrets Store CSI Driver provider.",
    k8s: "Use Sealed Secrets, External Secrets Operator, or HashiCorp Vault. Enable etcd encryption for at-rest secret protection.",
  },
};

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Get platform-specific guidance string for a given intent.
 *
 * @param {string} intent  — Abstract intent identifier (e.g. "expose_service")
 * @param {string} platform — One of: openshift, rosa, aro, eks, aks, gke, k8s
 * @returns {string} Guidance text suitable for injection into a system prompt,
 *                   or a generic fallback if the intent/platform is unknown.
 */
function getPlatformGuidance(intent, platform) {
  const p = (platform || "k8s").toLowerCase();
  const intentMap = GUIDANCE_TEMPLATES[intent];
  if (!intentMap) {
    return `No specific guidance available for intent "${intent}" on platform "${p}".`;
  }
  return intentMap[p] || intentMap.k8s || `No guidance available for platform "${p}" on intent "${intent}".`;
}

/**
 * Get the CLI command reference object for a platform.
 *
 * @param {string} platform — One of: openshift, rosa, aro, eks, aks, gke, k8s
 * @returns {object} Command reference with keys: cli, getpods, logs, describe,
 *                   apply, scale, rollout, exec, expose, nodeScale, identity, monitoring
 */
function getPlatformCommands(platform) {
  const p = (platform || "k8s").toLowerCase();
  const validPlatforms = ["openshift", "rosa", "aro", "eks", "aks", "gke", "k8s"];
  if (!validPlatforms.includes(p)) {
    return buildCommandRef("k8s");
  }
  return buildCommandRef(p);
}

/**
 * Get the full abstract-operations-to-platform mapping table.
 *
 * @returns {object} Mapping of abstract operation names to per-platform implementation
 *                   details including summary, commands, resources, and notes.
 */
function getAbstractMappings() {
  return ABSTRACT_MAPPINGS;
}

/**
 * Build a complete prompt section with platform-specific guidance for
 * the given intents. Returns a formatted string ready for injection
 * into a system prompt.
 *
 * @param {string}   platform — One of: openshift, rosa, aro, eks, aks, gke, k8s
 * @param {string[]} intents  — Array of abstract intent identifiers
 * @returns {string} Formatted prompt section with platform header and
 *                   per-intent guidance lines.
 */
function buildPlatformPromptSection(platform, intents) {
  const p = (platform || "k8s").toLowerCase();
  const meta = PLATFORM_META[p] || PLATFORM_META[PLATFORM.K8S];
  const lines = [];

  lines.push(`## Platform: ${meta.label}`);
  lines.push(`CLI: ${meta.cliSummary}`);

  if (!intents || intents.length === 0) {
    return lines.join("\n");
  }

  lines.push("");
  lines.push("### Platform-Specific Guidance");

  const intentLabels = {
    expose_service: "exposing services",
    check_ingress: "checking ingress",
    network_policy: "network policies",
    check_sa_security: "service account security",
    auth_config: "authentication configuration",
    node_autoscale: "node autoscaling",
    scale_nodes: "node scaling",
    cluster_upgrade: "cluster upgrades",
    addon_management: "add-on management",
    check_monitoring: "monitoring",
    check_logging: "logging",
    storage_config: "storage configuration",
    pod_security: "pod security",
    image_scanning: "image scanning",
    secret_management: "secret management",
  };

  for (const intent of intents) {
    const guidance = getPlatformGuidance(intent, p);
    const label = intentLabels[intent] || intent.replace(/_/g, " ");
    if (!guidance.startsWith("No specific guidance") && !guidance.startsWith("No guidance available")) {
      lines.push(`- For ${label}: ${guidance}`);
    }
  }

  return lines.join("\n");
}

export {
  getPlatformGuidance,
  getPlatformCommands,
  getAbstractMappings,
  buildPlatformPromptSection,
};
