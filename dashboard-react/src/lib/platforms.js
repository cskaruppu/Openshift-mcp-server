export const PLATFORM_MAP = {
  openshift: { key: "openshift", name: "OpenShift", icon: "\u{2B22}", color: "#e04040" },
  rancher:   { key: "rancher",   name: "Rancher",   icon: "\u{1F42E}", color: "#0075a8" },
  eks:       { key: "eks",       name: "Amazon EKS", icon: "\u{2601}", color: "#ff9900" },
  aks:       { key: "aks",       name: "Azure AKS",  icon: "\u{26C5}", color: "#0078d4" },
  gke:       { key: "gke",       name: "Google GKE", icon: "\u{1F310}", color: "#4285f4" },
  k8s:       { key: "k8s",       name: "Kubernetes", icon: "\u{2699}", color: "#326ce5" },
};

export function getPlatformInfo(platform) {
  return PLATFORM_MAP[(platform || "k8s").toLowerCase()] || PLATFORM_MAP.k8s;
}
