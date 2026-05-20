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
  "ebs-csi":     { resource: null,           intent: "storage",   w: 45 },
  addon:         { resource: null,           intent: "list",      w: 40 },
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
  defender:       { resource: null,          intent: "security",  w: 40 },
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
