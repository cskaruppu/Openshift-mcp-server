/**
 * Platform Auto-Detection
 *
 * Detects the Kubernetes distribution at startup by probing
 * platform-specific APIs and node labels. Result is cached
 * for the lifetime of the process.
 *
 * Supported platforms:
 *   openshift  — Red Hat OpenShift Container Platform (OCP)
 *   rosa       — Red Hat OpenShift on AWS (ROSA)
 *   aro        — Azure Red Hat OpenShift (ARO)
 *   eks        — Amazon Elastic Kubernetes Service
 *   aks        — Azure Kubernetes Service
 *   gke        — Google Kubernetes Engine
 *   k8s        — Vanilla / upstream Kubernetes
 */

let _detectedPlatform = null;
let _platformMeta = {};

const PLATFORM = {
  OPENSHIFT: "openshift",
  ROSA: "rosa",
  ARO: "aro",
  EKS: "eks",
  AKS: "aks",
  GKE: "gke",
  K8S: "k8s",
};

const PLATFORM_LABELS = {
  [PLATFORM.OPENSHIFT]: "Red Hat OpenShift",
  [PLATFORM.ROSA]: "Red Hat OpenShift on AWS (ROSA)",
  [PLATFORM.ARO]: "Azure Red Hat OpenShift (ARO)",
  [PLATFORM.EKS]: "Amazon EKS",
  [PLATFORM.AKS]: "Azure AKS",
  [PLATFORM.GKE]: "Google GKE",
  [PLATFORM.K8S]: "Kubernetes",
};

const PLATFORM_FAMILY = {
  [PLATFORM.OPENSHIFT]: "openshift",
  [PLATFORM.ROSA]: "openshift",
  [PLATFORM.ARO]: "openshift",
  [PLATFORM.EKS]: "kubernetes",
  [PLATFORM.AKS]: "kubernetes",
  [PLATFORM.GKE]: "kubernetes",
  [PLATFORM.K8S]: "kubernetes",
};

function isOpenShiftFamily(platform) {
  return PLATFORM_FAMILY[platform] === "openshift";
}

/**
 * Detect the Kubernetes platform by probing APIs and node labels.
 * @param {Function} apiGet - A function that performs GET requests (e.g. ocpGet or k8sGet)
 * @returns {Promise<{platform: string, meta: object}>}
 */
async function detectPlatform(apiGet) {
  const envOverride = process.env.PLATFORM;
  if (envOverride && envOverride !== "auto") {
    const p = envOverride.toLowerCase();
    if (Object.values(PLATFORM).includes(p)) {
      _detectedPlatform = p;
      _platformMeta = { source: "env", label: PLATFORM_LABELS[p] };
      return { platform: p, meta: _platformMeta };
    }
  }

  // 1. Check for OpenShift (OCP / ROSA / ARO)
  try {
    const cv = await apiGet("/apis/config.openshift.io/v1/clusterversions/version");
    if (cv && cv.status) {
      const infra = await apiGet("/apis/config.openshift.io/v1/infrastructures/cluster").catch(() => null);
      const platformType = infra?.status?.platformStatus?.type || "";

      if (platformType === "AWS") {
        const isRosa = await apiGet("/apis/config.openshift.io/v1/clusterversions/version")
          .then(r => JSON.stringify(r).includes("rosa"))
          .catch(() => false);
        if (isRosa) {
          _detectedPlatform = PLATFORM.ROSA;
        } else {
          _detectedPlatform = PLATFORM.OPENSHIFT;
        }
      } else if (platformType === "Azure") {
        _detectedPlatform = PLATFORM.ARO;
      } else {
        _detectedPlatform = PLATFORM.OPENSHIFT;
      }

      _platformMeta = {
        source: "api",
        label: PLATFORM_LABELS[_detectedPlatform],
        version: cv.status?.desired?.version || "unknown",
        channel: cv.spec?.channel || "unknown",
        platformType,
        family: "openshift",
      };
      return { platform: _detectedPlatform, meta: _platformMeta };
    }
  } catch {
    // Not OpenShift — continue detection
  }

  // 2. Check node labels for cloud platform
  try {
    const nodes = await apiGet("/api/v1/nodes?limit=5");
    const nodeItems = nodes?.items || [];

    for (const node of nodeItems) {
      const labels = node.metadata?.labels || {};
      const providerID = node.spec?.providerID || "";

      // EKS detection
      if (labels["eks.amazonaws.com/nodegroup"] ||
          labels["karpenter.sh/provisioner-name"] ||
          labels["node.kubernetes.io/instance-type"]?.startsWith("m5") ||
          providerID.startsWith("aws://")) {
        _detectedPlatform = PLATFORM.EKS;
        _platformMeta = {
          source: "node-labels",
          label: PLATFORM_LABELS[PLATFORM.EKS],
          region: labels["topology.kubernetes.io/region"] || labels["failure-domain.beta.kubernetes.io/region"] || "unknown",
          nodeGroup: labels["eks.amazonaws.com/nodegroup"] || "unknown",
          family: "kubernetes",
        };
        break;
      }

      // AKS detection
      if (labels["kubernetes.azure.com/cluster"] ||
          labels["kubernetes.azure.com/agentpool"] ||
          providerID.startsWith("azure://")) {
        _detectedPlatform = PLATFORM.AKS;
        _platformMeta = {
          source: "node-labels",
          label: PLATFORM_LABELS[PLATFORM.AKS],
          resourceGroup: labels["kubernetes.azure.com/cluster"] || "unknown",
          agentPool: labels["kubernetes.azure.com/agentpool"] || "unknown",
          family: "kubernetes",
        };
        break;
      }

      // GKE detection
      if (labels["cloud.google.com/gke-nodepool"] ||
          labels["cloud.google.com/gke-os-distribution"] ||
          providerID.startsWith("gce://")) {
        _detectedPlatform = PLATFORM.GKE;
        _platformMeta = {
          source: "node-labels",
          label: PLATFORM_LABELS[PLATFORM.GKE],
          nodePool: labels["cloud.google.com/gke-nodepool"] || "unknown",
          zone: labels["topology.kubernetes.io/zone"] || "unknown",
          family: "kubernetes",
        };
        break;
      }
    }
  } catch {
    // Could not read nodes
  }

  // 3. Fallback — vanilla Kubernetes
  if (!_detectedPlatform) {
    _detectedPlatform = PLATFORM.K8S;
    try {
      const ver = await apiGet("/version");
      _platformMeta = {
        source: "fallback",
        label: PLATFORM_LABELS[PLATFORM.K8S],
        gitVersion: ver?.gitVersion || "unknown",
        family: "kubernetes",
      };
    } catch {
      _platformMeta = { source: "fallback", label: PLATFORM_LABELS[PLATFORM.K8S], family: "kubernetes" };
    }
  }

  return { platform: _detectedPlatform, meta: _platformMeta };
}

function getPlatform() {
  return _detectedPlatform || PLATFORM.OPENSHIFT;
}

function getPlatformMeta() {
  return { ..._platformMeta };
}

function getPlatformLabel() {
  return PLATFORM_LABELS[getPlatform()] || "Unknown";
}

function getPlatformFamily() {
  return PLATFORM_FAMILY[getPlatform()] || "kubernetes";
}

function resetDetection() {
  _detectedPlatform = null;
  _platformMeta = {};
}

export {
  PLATFORM,
  PLATFORM_LABELS,
  PLATFORM_FAMILY,
  detectPlatform,
  getPlatform,
  getPlatformMeta,
  getPlatformLabel,
  getPlatformFamily,
  isOpenShiftFamily,
  resetDetection,
};
