/**
 * Server-side YAML generator for TCS Agentic AI cluster agent deployment.
 * Ported from console/src/views/ClusterPickerView.jsx generateAgentYAML().
 */

const PLATFORMS = {
  openshift: { name: "OpenShift",    ns: "openshift-mcp", cli: "oc" },
  rancher:   { name: "Rancher",      ns: "openshift-mcp", cli: "kubectl" },
  eks:       { name: "Amazon EKS",   ns: "openshift-mcp", cli: "kubectl" },
  aks:       { name: "Azure AKS",    ns: "openshift-mcp", cli: "kubectl" },
  gke:       { name: "Google GKE",   ns: "openshift-mcp", cli: "kubectl" },
  k8s:       { name: "Kubernetes",   ns: "openshift-mcp", cli: "kubectl" },
};

const AGENT_IMAGE = "quay.io/karuppucs/openshift-mcp-server:latest";
const APP_LABEL = "agentic-ai-agent";

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
export function generateAgentYAML(platform, clusterName, apiUrl, allowActions, hubServerUrl, hubApiToken) {
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
  L.push(`# Registry : ${AGENT_IMAGE}`);
  L.push(`# Generated: ${date}`);
  L.push("# ============================================================");
  L.push("#");
  L.push(`# Apply with: ${p.cli} apply -f agentic-ai-agent-${platform}.yaml`);
  L.push(`# Remove with: ${p.cli} delete -f agentic-ai-agent-${platform}.yaml`);
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
  L.push("---", "apiVersion: v1", "kind: Namespace", "metadata:", `  name: ${ns}`, "  labels:", "    app.kubernetes.io/name: agentic-ai-agent", "    app.kubernetes.io/part-of: agentic-ai-agent", "    app.kubernetes.io/managed-by: openshift-mcp-hub");
  if (platform === "openshift") L.push("  annotations:", '    openshift.io/description: "TCS AI-Native Cluster Agent"');
  L.push("");

  // ServiceAccount
  L.push("---", "apiVersion: v1", "kind: ServiceAccount", "metadata:", "  name: agentic-ai-agent", `  namespace: ${ns}`, "  labels:", "    app.kubernetes.io/name: agentic-ai-agent");
  if (platform === "eks") L.push("  # Uncomment for IRSA:", "  # annotations:", "  #   eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT:role/agentic-ai-agent");
  else if (platform === "aks") L.push("  # Uncomment for Azure Workload Identity:", "  # annotations:", "  #   azure.workload.identity/client-id: <CLIENT_ID>");
  else if (platform === "gke") L.push("  # Uncomment for GKE Workload Identity:", "  # annotations:", "  #   iam.gke.io/gcp-service-account: agentic-ai-agent@PROJECT.iam.gserviceaccount.com");
  L.push("");

  // ClusterRole
  L.push("---", "apiVersion: rbac.authorization.k8s.io/v1", "kind: ClusterRole", "metadata:", "  name: agentic-ai-agent-role", "  labels:", "    app.kubernetes.io/name: agentic-ai-agent", "rules:");
  L.push('  - apiGroups: [""]', "    resources: [pods, pods/log, nodes, services, events, namespaces, configmaps, persistentvolumeclaims, endpoints, replicationcontrollers, serviceaccounts, resourcequotas, limitranges]", '    verbs: ["get", "list", "watch"]');
  L.push('  - apiGroups: ["apps"]', "    resources: [deployments, statefulsets, daemonsets, replicasets]", '    verbs: ["get", "list", "watch"]');
  L.push('  - apiGroups: ["apps"]', "    resources: [deployments]", "    resourceNames: [agentic-ai-agent]", '    verbs: ["patch"]');
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
  L.push('  - apiGroups: ["rbac.authorization.k8s.io"]', "    resources: [clusterroles]", "    resourceNames: [agentic-ai-agent-role]", '    verbs: ["update", "patch"]');
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
  L.push("---", "apiVersion: rbac.authorization.k8s.io/v1", "kind: ClusterRoleBinding", "metadata:", "  name: agentic-ai-agent-binding", "  labels:", "    app.kubernetes.io/name: agentic-ai-agent", "roleRef:", "  apiGroup: rbac.authorization.k8s.io", "  kind: ClusterRole", "  name: agentic-ai-agent-role", "subjects:", "  - kind: ServiceAccount", "    name: agentic-ai-agent", `    namespace: ${ns}`);
  L.push("");

  // ConfigMap — spoke mode (stateless, no DB)
  L.push("---", "apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: agentic-ai-agent-config", `  namespace: ${ns}`, "  labels:", "    app.kubernetes.io/name: agentic-ai-agent", "data:");
  L.push('  MCP_MODE: "spoke"', '  MCP_TRANSPORT: "sse"', '  MCP_SERVER_PORT: "3000"', '  LOG_LEVEL: "info"', `  HUB_URL: "${serverUrl}"`, `  CLUSTER_NAME: "${safeName}"`, `  CLUSTER_PLATFORM: "${platform}"`, '  DEPLOYMENT_NAME: "agentic-ai-agent"', `  MCP_NAMESPACE: "${ns}"`, '  AUTH_MODE: "none"', '  EMERGENCY_AUTO_FIX: "false"', '  ALLOW_PRIVATE_CLUSTER_IPS: "true"', '  HUB_TLS_SKIP_VERIFY: "true"', `  ALLOW_REMOTE_ACTIONS: "${allowActions ? "true" : "false"}"`);
  if (apiUrl) L.push(`  API_SERVER_URL: "${apiUrl}"`);
  L.push("");

  // Secret
  L.push("---", "apiVersion: v1", "kind: Secret", "metadata:", "  name: agentic-ai-agent-secret", `  namespace: ${ns}`, "  labels:", "    app.kubernetes.io/name: agentic-ai-agent", "type: Opaque", "stringData:", `  MCP_API_TOKEN: "${hubApiToken || ""}"`, `  HUB_API_TOKEN: "${hubApiToken || ""}"`, `  AGENT_ID: "${safeName}"`);
  L.push("");

  // Deployment — spoke mode (stateless, phones home to hub)
  L.push("---", "apiVersion: apps/v1", "kind: Deployment", "metadata:", "  name: agentic-ai-agent", `  namespace: ${ns}`, "  labels:", "    app: agentic-ai-agent", "    app.kubernetes.io/name: agentic-ai-agent", "    app.kubernetes.io/component: spoke", '    app.kubernetes.io/version: "1.2.0"', "spec:", "  replicas: 1", "  revisionHistoryLimit: 3", "  strategy:", "    type: RollingUpdate", "    rollingUpdate:", "      maxUnavailable: 0", "      maxSurge: 1", "  selector:", "    matchLabels:", "      app: agentic-ai-agent", "  template:", "    metadata:", "      labels:", "        app: agentic-ai-agent", "        app.kubernetes.io/name: agentic-ai-agent", '        tcs.com/mcp-mode: spoke', `        tcs.com/cluster-name: "${safeName}"`, "      annotations:", '        prometheus.io/scrape: "true"', '        prometheus.io/port: "3000"', '        prometheus.io/path: "/status"', "    spec:", "      serviceAccountName: agentic-ai-agent");
  if (platform === "openshift") L.push("      securityContext:", "        runAsNonRoot: true");
  else L.push("      securityContext:", "        runAsNonRoot: true", "        runAsUser: 1001", "        runAsGroup: 1001", "        fsGroup: 1001");
  L.push("      dnsPolicy: None", "      dnsConfig:", "        nameservers:", "          - 10.131.19.154", "        searches:", `          - ${ns}.svc.cluster.local`, "          - svc.cluster.local", "          - cluster.local", "          - caaslab.local", "        options:", "          - name: ndots", '            value: "5"');
  L.push("      terminationGracePeriodSeconds: 30", "      containers:", "        - name: agent", `          image: ${AGENT_IMAGE}`, "          imagePullPolicy: Always", "          env:", "            - name: NODE_EXTRA_CA_CERTS", "              value: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt", "            - name: NODE_TLS_REJECT_UNAUTHORIZED", '              value: "0"', "          envFrom:", "            - configMapRef:", "                name: agentic-ai-agent-config", "            - secretRef:", "                name: agentic-ai-agent-secret", "                optional: true", "          ports:", "            - containerPort: 3000", "              name: http", "              protocol: TCP", "          resources:", "            requests:", "              cpu: 100m", "              memory: 128Mi", "            limits:", "              cpu: 500m", "              memory: 512Mi");
  L.push("          livenessProbe:", "            httpGet:", "              path: /healthz", "              port: 3000", "            initialDelaySeconds: 15", "            periodSeconds: 30", "            timeoutSeconds: 5", "            failureThreshold: 3");
  L.push("          readinessProbe:", "            httpGet:", "              path: /readyz", "              port: 3000", "            initialDelaySeconds: 10", "            periodSeconds: 10", "            timeoutSeconds: 3", "            failureThreshold: 2");
  L.push("          securityContext:", "            allowPrivilegeEscalation: false", "            capabilities:", "              drop:", "                - ALL");
  L.push("");

  // Service
  L.push("---", "apiVersion: v1", "kind: Service", "metadata:", "  name: agentic-ai-agent", `  namespace: ${ns}`, "  labels:", "    app: agentic-ai-agent", "spec:", "  type: ClusterIP", "  selector:", "    app: agentic-ai-agent", "  ports:", "    - port: 3000", "      targetPort: 3000", "      protocol: TCP", "      name: http");
  L.push("");

  // Route / Ingress
  if (platform === "openshift") {
    L.push("---", "apiVersion: route.openshift.io/v1", "kind: Route", "metadata:", "  name: agentic-ai-agent", `  namespace: ${ns}`, "  labels:", "    app: agentic-ai-agent", "spec:", "  to:", "    kind: Service", "    name: agentic-ai-agent", "  port:", "    targetPort: http", "  tls:", "    termination: edge", "    insecureEdgeTerminationPolicy: Redirect");
  } else {
    L.push("# Uncomment to expose via Ingress:", "# ---", "# apiVersion: networking.k8s.io/v1", "# kind: Ingress", "# metadata:", `#   name: agentic-ai-agent`, `#   namespace: ${ns}`);
    if (platform === "eks") L.push("#   annotations:", "#     kubernetes.io/ingress.class: alb");
    else if (platform === "gke") L.push("#   annotations:", "#     kubernetes.io/ingress.class: gce");
    else if (platform === "aks") L.push("#   annotations:", "#     kubernetes.io/ingress.class: azure/application-gateway");
    else L.push("#   annotations:", "#     kubernetes.io/ingress.class: nginx");
    L.push("# spec:", "#   rules:", `#     - host: agentic-ai-agent.${safeName}.local`, "#       http:", "#         paths:", "#           - path: /", "#             pathType: Prefix", "#             backend:", "#               service:", "#                 name: agentic-ai-agent", "#                 port:", "#                   number: 3000");
  }
  L.push("");
  return L.join("\n");
}
