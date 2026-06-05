/**
 * Platform-Specific NLU Supplements
 *
 * Additional verb table entries for platform-specific terms.
 * These are MERGED into the existing VERB_TABLE at startup,
 * NOT replacing any existing entries.
 *
 * The existing nlu.js is NEVER modified.
 */

const NLU_VERBS_COMMON = {
  // Standard K8s terms not in original OCP-focused verb table
  ingress:     { resource: "ingress",    intent: "list",    w: 50 },
  ingressclass:{ resource: "ingress",    intent: "list",    w: 40 },
  csi:         { resource: "csidriver",   intent: "list",    w: 45 },
  storageclass:{ resource: "storageclass",intent: "list",    w: 50 },
  storageclasses:{resource:"storageclass",intent: "list",    w: 50 },
  kubeconfig:  { resource: null,          intent: "help",    w: 30 },
  kubectl:     { resource: null,          intent: "help",    w: 20 },
  helm:        { resource: null,          intent: "help",    w: 20 },
  kustomize:   { resource: null,          intent: "help",    w: 20 },
  // Cross-platform lifecycle
  canary:      { resource: "deployment",  intent: "deploy_strategy", w: 55 },
  "blue-green":{ resource: "deployment",  intent: "deploy_strategy", w: 55 },
  progressive: { resource: "deployment",  intent: "deploy_strategy", w: 50 },
  expose:      { resource: "service",     intent: "expose_service",  w: 55 },
  loadbalancer:{ resource: "service",     intent: "expose_service",  w: 50 },
  vpa:         { resource: "pod",         intent: "vpa",             w: 55 },
  "vertical-autoscaler":{ resource: "pod",intent: "vpa",             w: 55 },
  finops:      { resource: null,          intent: "cost_optimization",w: 50 },
  cost:        { resource: null,          intent: "cost_optimization",w: 40 },
  mesh:        { resource: null,          intent: "service_mesh",    w: 50 },
  istio:       { resource: null,          intent: "service_mesh",    w: 55 },
  envoy:       { resource: null,          intent: "service_mesh",    w: 45 },
  sidecar:     { resource: "pod",         intent: "service_mesh",    w: 40 },
  isolate:     { resource: null,          intent: "incident_response",w: 55 },
  quarantine:  { resource: null,          intent: "incident_response",w: 55 },
  "external-secret":{ resource: null,     intent: "secret_management",w: 55 },
  "sealed-secret":{ resource: null,       intent: "secret_management",w: 55 },
  vault:       { resource: null,          intent: "secret_management",w: 50 },
};

const NLU_VERBS_EKS = {
  alb:           { resource: "ingress",      intent: "list",      w: 55 },
  targetgroup:   { resource: "ingress",      intent: "list",      w: 45 },
  irsa:          { resource: null,           intent: "identity",  w: 60 },
  karpenter:     { resource: "nodepool",     intent: "list",      w: 60 },
  nodegroup:     { resource: "node",         intent: "list",      w: 55 },
  nodeclaim:     { resource: "nodepool",     intent: "list",      w: 50 },
  provisioner:   { resource: "nodepool",     intent: "list",      w: 50 },
  ecr:           { resource: null,           intent: "imagescan", w: 50 },
  "vpc-cni":     { resource: null,           intent: "network",   w: 45 },
  "aws-node":    { resource: null,           intent: "network",   w: 40 },
  "security-group":{ resource: null,         intent: "network",   w: 45 },
  eks:           { resource: null,           intent: "help",      w: 30 },
  fargate:       { resource: "pod",          intent: "list",      w: 40 },
  "ebs-csi":     { resource: null,           intent: "storage_config",w: 45 },
  addon:         { resource: null,           intent: "addon_management",w: 45 },
  "eks-addon":   { resource: null,           intent: "addon_management",w: 50 },
  guardduty:     { resource: null,           intent: "cloud_imagescan",w: 50 },
  "ecr-scan":    { resource: null,           intent: "cloud_imagescan",w: 50 },
  cloudwatch:    { resource: null,           intent: "cloud_monitoring",w: 50 },
  "container-insights":{ resource: null,     intent: "cloud_monitoring",w: 55 },
  "secrets-manager":{ resource: null,        intent: "secret_management",w: 50 },
};

const NLU_VERBS_AKS = {
  agic:           { resource: "ingress",     intent: "list",      w: 55 },
  "app-gateway":  { resource: "ingress",     intent: "list",      w: 50 },
  aad:            { resource: null,          intent: "identity",  w: 55 },
  "azure-ad":     { resource: null,          intent: "identity",  w: 55 },
  "managed-identity":{ resource: null,       intent: "identity",  w: 50 },
  "workload-identity":{ resource: null,      intent: "identity",  w: 55 },
  "pod-identity": { resource: null,          intent: "identity",  w: 50 },
  vmss:           { resource: "node",        intent: "list",      w: 50 },
  agentpool:      { resource: "node",        intent: "list",      w: 50 },
  acr:            { resource: null,          intent: "imagescan", w: 50 },
  "azure-cni":    { resource: null,          intent: "network",   w: 45 },
  kubenet:        { resource: null,          intent: "network",   w: 40 },
  "azure-policy": { resource: null,          intent: "compliance",w: 45 },
  aks:            { resource: null,          intent: "help",      w: 30 },
  arc:            { resource: null,          intent: "fleet",     w: 40 },
  "azure-arc":    { resource: null,          intent: "fleet",     w: 45 },
  defender:       { resource: null,          intent: "cloud_imagescan",w: 45 },
  "aks-diagnostics":{ resource: null,      intent: "diagnose",  w: 45 },
  "azure-monitor":{ resource: null,        intent: "cloud_monitoring",w: 50 },
  "azure-disk":   { resource: null,        intent: "storage_config",w: 45 },
  "azure-file":   { resource: null,        intent: "storage_config",w: 45 },
  "key-vault":    { resource: null,        intent: "secret_management",w: 50 },
  "aks-extension":{ resource: null,        intent: "addon_management",w: 50 },
};

const NLU_VERBS_GKE = {
  neg:             { resource: "ingress",    intent: "list",      w: 55 },
  "backend-config":{ resource: "ingress",    intent: "list",      w: 45 },
  gsa:             { resource: null,         intent: "identity",  w: 50 },
  "workload-identity":{ resource: null,      intent: "identity",  w: 55 },
  "node-pool":     { resource: "node",       intent: "list",      w: 50 },
  nodepool:        { resource: "node",       intent: "list",      w: 50 },
  preemptible:     { resource: "node",       intent: "list",      w: 40 },
  spot:            { resource: "node",       intent: "list",      w: 35 },
  gar:             { resource: null,         intent: "imagescan", w: 50 },
  gcr:             { resource: null,         intent: "imagescan", w: 45 },
  "binary-auth":   { resource: null,         intent: "security",  w: 50 },
  "config-connector":{ resource: null,       intent: "list",      w: 40 },
  cnrm:            { resource: null,         intent: "list",      w: 35 },
  autopilot:       { resource: null,         intent: "help",      w: 35 },
  gke:             { resource: null,         intent: "help",      w: 30 },
  anthos:          { resource: null,         intent: "fleet",     w: 45 },
  "config-sync":   { resource: null,         intent: "gitops",    w: 50 },
  "managed-cert":  { resource: null,         intent: "certlife",  w: 50 },
  "artifact-analysis":{ resource: null,    intent: "cloud_imagescan",w: 50 },
  "cloud-operations":{ resource: null,     intent: "cloud_monitoring",w: 50 },
  "cloud-logging":{ resource: null,        intent: "cloud_monitoring",w: 45 },
  "gce-pd":       { resource: null,        intent: "storage_config",w: 45 },
  "secret-manager":{ resource: null,       intent: "secret_management",w: 50 },
  "gke-addon":    { resource: null,        intent: "addon_management",w: 50 },
};

/**
 * Get the NLU supplement verbs for a given platform.
 * @param {string} platform - Detected platform identifier
 * @returns {object} Verb table entries to merge
 */
function getNLUSupplements(platform) {
  const supplements = { ...NLU_VERBS_COMMON };

  switch (platform) {
    case "eks":
      Object.assign(supplements, NLU_VERBS_EKS);
      break;
    case "aks":
      Object.assign(supplements, NLU_VERBS_AKS);
      break;
    case "gke":
      Object.assign(supplements, NLU_VERBS_GKE);
      break;
    case "openshift":
    case "rosa":
    case "aro":
      // OpenShift verbs are already in the existing nlu.js
      break;
    default:
      // Vanilla K8s — just common supplements
      break;
  }

  return supplements;
}

/**
 * Get platform-specific stop words to add.
 */
function getNLUStopWords(platform) {
  const words = new Set(Object.keys(NLU_VERBS_COMMON));
  const platformVerbs = {
    eks: NLU_VERBS_EKS,
    aks: NLU_VERBS_AKS,
    gke: NLU_VERBS_GKE,
  };
  if (platformVerbs[platform]) {
    Object.keys(platformVerbs[platform]).forEach(w => words.add(w));
  }
  return [...words];
}

export {
  NLU_VERBS_COMMON,
  NLU_VERBS_EKS,
  NLU_VERBS_AKS,
  NLU_VERBS_GKE,
  getNLUSupplements,
  getNLUStopWords,
};
