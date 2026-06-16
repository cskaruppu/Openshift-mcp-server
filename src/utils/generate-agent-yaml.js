/**
 * Server-side YAML generator for TCS Agentic AI cluster agent deployment.
 * Ported from console/src/views/ClusterPickerView.jsx generateAgentYAML().
 */

const PLATFORMS = {
  openshift: { name: "OpenShift",    ns: "openshift-tcs-agentic", cli: "oc" },
  rancher:   { name: "Rancher",      ns: "tcs-agentic-system",   cli: "kubectl" },
  eks:       { name: "Amazon EKS",   ns: "tcs-agentic-system",   cli: "kubectl" },
  aks:       { name: "Azure AKS",    ns: "tcs-agentic-system",   cli: "kubectl" },
  gke:       { name: "Google GKE",   ns: "tcs-agentic-system",   cli: "kubectl" },
  k8s:       { name: "Kubernetes",   ns: "tcs-agentic-system",   cli: "kubectl" },
};

/**
 * Generate the full multi-resource YAML manifest for deploying the TCS
 * Agentic AI cluster agent on a target cluster.
 *
 * @param {string} platform   - One of: openshift, rancher, eks, aks, gke, k8s
 * @param {string} clusterName - Human-readable cluster name
 * @param {string} apiUrl     - API server URL of the target cluster (optional)
 * @param {boolean} allowActions - Whether write/mutate RBAC rules should be included
 * @param {string} hubServerUrl  - The hub server URL the agent should phone home to
 * @returns {string} The YAML manifest as a string
 */
export function generateAgentYAML(platform, clusterName, apiUrl, allowActions, hubServerUrl) {
  const p = PLATFORMS[platform] || PLATFORMS.k8s;
  const ns = p.ns;
  const safeName = (clusterName || "my-cluster").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const serverUrl = hubServerUrl || "http://localhost:3001";
  const date = new Date().toISOString().split("T")[0];

  const L = [];
  L.push("# ============================================================");
  L.push("# TCS Agentic AI — Cluster Agent Deployment");
  L.push(`# Platform : ${p.name}`);
  L.push(`# Cluster  : ${clusterName || safeName}`);
  L.push("# Registry : quay.io/karuppucs/tcs-agentic-ai:latest");
  L.push(`# Generated: ${date}`);
  L.push("# ============================================================");
  L.push("#");
  L.push(`# Apply with: ${p.cli} apply -f tcs-agentic-ai-${platform}.yaml`);
  L.push(`# Remove with: ${p.cli} delete -f tcs-agentic-ai-${platform}.yaml`);
  L.push("#");
  L.push("# Prerequisites:");
  L.push("#   - Cluster admin or equivalent RBAC permissions");
  L.push(`#   - Network access from cluster to hub: ${serverUrl}`);
  if (platform === "openshift") L.push("#   - OpenShift 4.x with cluster-admin or dedicated role");
  else if (platform === "eks") { L.push("#   - EKS cluster with aws-auth ConfigMap configured"); L.push("#   - ECR pull access or public quay.io access"); }
  else if (platform === "aks") L.push("#   - AKS cluster with Azure RBAC or Kubernetes RBAC");
  else if (platform === "gke") L.push("#   - GKE cluster with Workload Identity or node SA");
  else if (platform === "rancher") L.push("#   - Rancher-managed cluster with project access");
  L.push("# ============================================================");
  L.push("");

  // Namespace
  L.push("---", "apiVersion: v1", "kind: Namespace", "metadata:", `  name: ${ns}`, "  labels:", "    app.kubernetes.io/name: tcs-agentic-ai", "    app.kubernetes.io/part-of: tcs-agentic-ai", "    app.kubernetes.io/managed-by: tcs-agentic-hub");
  if (platform === "openshift") L.push("  annotations:", '    openshift.io/description: "TCS AI-Native Cluster Agent"');
  L.push("");

  // ServiceAccount
  L.push("---", "apiVersion: v1", "kind: ServiceAccount", "metadata:", "  name: tcs-agentic-ai", `  namespace: ${ns}`, "  labels:", "    app.kubernetes.io/name: tcs-agentic-ai");
  if (platform === "eks") L.push("  # Uncomment for IRSA:", "  # annotations:", "  #   eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT:role/tcs-agentic-ai");
  else if (platform === "aks") L.push("  # Uncomment for Azure Workload Identity:", "  # annotations:", "  #   azure.workload.identity/client-id: <CLIENT_ID>");
  else if (platform === "gke") L.push("  # Uncomment for GKE Workload Identity:", "  # annotations:", "  #   iam.gke.io/gcp-service-account: tcs-agentic-ai@PROJECT.iam.gserviceaccount.com");
  L.push("");

  // ClusterRole
  L.push("---", "apiVersion: rbac.authorization.k8s.io/v1", "kind: ClusterRole", "metadata:", "  name: tcs-agentic-ai-role", "  labels:", "    app.kubernetes.io/name: tcs-agentic-ai", "rules:");
  L.push('  - apiGroups: [""]', "    resources: [pods, pods/log, nodes, services, events, namespaces, configmaps, persistentvolumeclaims, endpoints, replicationcontrollers, serviceaccounts, resourcequotas, limitranges]", '    verbs: ["get", "list", "watch"]');
  L.push('  - apiGroups: ["apps"]', "    resources: [deployments, statefulsets, daemonsets, replicasets]", '    verbs: ["get", "list", "watch"]');
  L.push('  - apiGroups: ["apps"]', "    resources: [deployments]", "    resourceNames: [tcs-agentic-ai]", '    verbs: ["patch"]');
  if (allowActions) {
    L.push("  # Remote actions (write) — ENABLED");
    L.push('  - apiGroups: ["apps"]', "    resources: [deployments, statefulsets, daemonsets, deployments/scale, statefulsets/scale]", '    verbs: ["update", "patch"]');
    L.push('  - apiGroups: [""]', "    resources: [pods]", '    verbs: ["delete"]');
    L.push('  - apiGroups: [""]', "    resources: [nodes]", '    verbs: ["patch", "update"]');
    if (platform === "openshift") L.push('  - apiGroups: ["config.openshift.io"]', "    resources: [clusterversions]", '    verbs: ["patch", "update"]');
  }
  L.push('  - apiGroups: ["batch"]', "    resources: [jobs, cronjobs]", '    verbs: ["get", "list", "watch"]');
  L.push('  - apiGroups: ["networking.k8s.io"]', "    resources: [ingresses, networkpolicies]", '    verbs: ["get", "list", "watch"]');
  L.push('  - apiGroups: ["metrics.k8s.io"]', "    resources: [pods, nodes]", '    verbs: ["get", "list"]');
  L.push('  - apiGroups: ["storage.k8s.io"]', "    resources: [storageclasses, volumeattachments]", '    verbs: ["get", "list", "watch"]');
  L.push('  - apiGroups: ["autoscaling"]', "    resources: [horizontalpodautoscalers]", '    verbs: ["get", "list", "watch"]');
  L.push('  - apiGroups: ["policy"]', "    resources: [poddisruptionbudgets]", '    verbs: ["get", "list", "watch"]');
  L.push('  - apiGroups: ["rbac.authorization.k8s.io"]', "    resources: [clusterroles, clusterrolebindings, roles, rolebindings]", '    verbs: ["get", "list"]');
  L.push('  - apiGroups: ["rbac.authorization.k8s.io"]', "    resources: [clusterroles]", "    resourceNames: [tcs-agentic-ai-role]", '    verbs: ["update", "patch"]');
  L.push('  - apiGroups: ["argoproj.io"]', "    resources: [applications, applicationsets]", '    verbs: ["get", "list"]');
  L.push('  - apiGroups: ["velero.io"]', "    resources: [backups, schedules, backupstoragelocations]", '    verbs: ["get", "list"]');
  L.push('  - apiGroups: ["aquasecurity.github.io"]', "    resources: [vulnerabilityreports, configauditreports]", '    verbs: ["get", "list"]');

  if (platform === "openshift") {
    L.push('  - apiGroups: ["route.openshift.io"]', "    resources: [routes]", '    verbs: ["get", "list", "watch"]');
    L.push('  - apiGroups: ["apps.openshift.io"]', "    resources: [deploymentconfigs]", '    verbs: ["get", "list", "watch"]');
    L.push('  - apiGroups: ["project.openshift.io"]', "    resources: [projects]", '    verbs: ["get", "list"]');
    L.push('  - apiGroups: ["config.openshift.io"]', "    resources: [clusterversions, clusteroperators, infrastructures]", '    verbs: ["get", "list"]');
    L.push('  - apiGroups: ["machine.openshift.io"]', "    resources: [machines, machinesets]", '    verbs: ["get", "list"]');
    L.push('  - apiGroups: ["security.openshift.io"]', "    resources: [securitycontextconstraints]", '    verbs: ["get", "list"]');
    L.push('  - apiGroups: ["secscan.quay.redhat.com"]', "    resources: [imagemanifestvulns]", '    verbs: ["get", "list"]');
  }
  if (platform === "rancher") {
    L.push('  - apiGroups: ["management.cattle.io"]', "    resources: [clusters, nodes]", '    verbs: ["get", "list", "watch"]');
    L.push('  - apiGroups: ["fleet.cattle.io"]', "    resources: [bundles, gitrepos]", '    verbs: ["get", "list"]');
  }
  if (platform === "eks") L.push('  - apiGroups: ["eks.amazonaws.com"]', '    resources: ["*"]', '    verbs: ["get", "list"]');
  if (platform === "gke") L.push('  - apiGroups: ["cloud.google.com"]', '    resources: ["*"]', '    verbs: ["get", "list"]');
  L.push("");

  // ClusterRoleBinding
  L.push("---", "apiVersion: rbac.authorization.k8s.io/v1", "kind: ClusterRoleBinding", "metadata:", "  name: tcs-agentic-ai-binding", "  labels:", "    app.kubernetes.io/name: tcs-agentic-ai", "roleRef:", "  apiGroup: rbac.authorization.k8s.io", "  kind: ClusterRole", "  name: tcs-agentic-ai-role", "subjects:", "  - kind: ServiceAccount", "    name: tcs-agentic-ai", `    namespace: ${ns}`);
  L.push("");

  // ConfigMap
  L.push("---", "apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: tcs-agentic-ai-config", `  namespace: ${ns}`, "  labels:", "    app.kubernetes.io/name: tcs-agentic-ai", "data:");
  L.push(`  HUB_SERVER_URL: "${serverUrl}"`, `  CLUSTER_NAME: "${safeName}"`, `  CLUSTER_PLATFORM: "${platform}"`, '  DEPLOYMENT_NAME: "tcs-agentic-ai"', '  SCAN_INTERVAL: "60"', '  LOG_LEVEL: "info"', '  HUB_TLS_SKIP_VERIFY: "true"', `  ALLOW_REMOTE_ACTIONS: "${allowActions ? "true" : "false"}"`);
  if (apiUrl) L.push(`  API_SERVER_URL: "${apiUrl}"`);
  L.push("");

  // Secret
  L.push("---", "apiVersion: v1", "kind: Secret", "metadata:", "  name: tcs-agentic-ai-secret", `  namespace: ${ns}`, "  labels:", "    app.kubernetes.io/name: tcs-agentic-ai", "type: Opaque", "stringData:", "  # Agent uses in-cluster ServiceAccount token by default.", '  # Uncomment to override:', '  # BEARER_TOKEN: "sha256~xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"', `  AGENT_ID: "${safeName}"`);
  L.push("");

  // Deployment
  L.push("---", "apiVersion: apps/v1", "kind: Deployment", "metadata:", "  name: tcs-agentic-ai", `  namespace: ${ns}`, "  labels:", "    app: tcs-agentic-ai", "    app.kubernetes.io/name: tcs-agentic-ai", '    app.kubernetes.io/version: "1.2.0"', "spec:", "  replicas: 1", "  revisionHistoryLimit: 3", "  strategy:", "    type: RollingUpdate", "    rollingUpdate:", "      maxUnavailable: 0", "      maxSurge: 1", "  selector:", "    matchLabels:", "      app: tcs-agentic-ai", "  template:", "    metadata:", "      labels:", "        app: tcs-agentic-ai", "        app.kubernetes.io/name: tcs-agentic-ai", "      annotations:", '        prometheus.io/scrape: "true"', '        prometheus.io/port: "8080"', '        prometheus.io/path: "/status"', "    spec:", "      serviceAccountName: tcs-agentic-ai");
  if (platform === "openshift") L.push("      securityContext:", "        runAsNonRoot: true");
  else L.push("      securityContext:", "        runAsNonRoot: true", "        runAsUser: 1001", "        runAsGroup: 1001", "        fsGroup: 1001");
  L.push("      terminationGracePeriodSeconds: 30", "      containers:", "        - name: agent", "          image: quay.io/karuppucs/tcs-agentic-ai:latest", "          imagePullPolicy: Always", "          env:", "            - name: NODE_EXTRA_CA_CERTS", "              value: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt", "            - name: NODE_TLS_REJECT_UNAUTHORIZED", '              value: "0"', "          envFrom:", "            - configMapRef:", "                name: tcs-agentic-ai-config", "            - secretRef:", "                name: tcs-agentic-ai-secret", "                optional: true", "          ports:", "            - containerPort: 8080", "              name: http", "              protocol: TCP", "          resources:", "            requests:", "              cpu: 50m", "              memory: 64Mi", "            limits:", "              cpu: 200m", "              memory: 128Mi");
  L.push("          livenessProbe:", "            httpGet:", "              path: /healthz", "              port: 8080", "            initialDelaySeconds: 10", "            periodSeconds: 30", "            timeoutSeconds: 5", "            failureThreshold: 3");
  L.push("          readinessProbe:", "            httpGet:", "              path: /readyz", "              port: 8080", "            initialDelaySeconds: 5", "            periodSeconds: 10", "            timeoutSeconds: 3", "            failureThreshold: 2");
  L.push("          securityContext:", "            allowPrivilegeEscalation: false", "            capabilities:", "              drop:", "                - ALL");
  L.push("");

  // Service
  L.push("---", "apiVersion: v1", "kind: Service", "metadata:", "  name: tcs-agentic-ai", `  namespace: ${ns}`, "  labels:", "    app: tcs-agentic-ai", "spec:", "  type: ClusterIP", "  selector:", "    app: tcs-agentic-ai", "  ports:", "    - port: 8080", "      targetPort: 8080", "      protocol: TCP", "      name: http");
  L.push("");

  // Route / Ingress
  if (platform === "openshift") {
    L.push("---", "apiVersion: route.openshift.io/v1", "kind: Route", "metadata:", "  name: tcs-agentic-ai", `  namespace: ${ns}`, "  labels:", "    app: tcs-agentic-ai", "spec:", "  to:", "    kind: Service", "    name: tcs-agentic-ai", "  port:", "    targetPort: http", "  tls:", "    termination: edge", "    insecureEdgeTerminationPolicy: Redirect");
  } else {
    L.push("# Uncomment to expose via Ingress:", "# ---", "# apiVersion: networking.k8s.io/v1", "# kind: Ingress", "# metadata:", `#   name: tcs-agentic-ai`, `#   namespace: ${ns}`);
    if (platform === "eks") L.push("#   annotations:", "#     kubernetes.io/ingress.class: alb");
    else if (platform === "gke") L.push("#   annotations:", "#     kubernetes.io/ingress.class: gce");
    else if (platform === "aks") L.push("#   annotations:", "#     kubernetes.io/ingress.class: azure/application-gateway");
    else L.push("#   annotations:", "#     kubernetes.io/ingress.class: nginx");
    L.push("# spec:", "#   rules:", `#     - host: tcs-agentic-ai.${safeName}.local`, "#       http:", "#         paths:", "#           - path: /", "#             pathType: Prefix", "#             backend:", "#               service:", "#                 name: tcs-agentic-ai", "#                 port:", "#                   number: 8080");
  }
  L.push("");
  return L.join("\n");
}
