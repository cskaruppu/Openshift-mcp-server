/**
 * Server-side YAML generator for TCS Agentic AI cluster agent deployment.
 * Aligned with deploy/mcp/deploy.sh — every resource, env var, and RBAC rule
 * matches the shell script so curl-applied YAML behaves identically.
 */

const PLATFORMS = {
  openshift: { name: "OpenShift",    ns: "openshift-mcp",      cli: "oc" },
  rancher:   { name: "Rancher",      ns: "tcs-agentic-system", cli: "kubectl" },
  eks:       { name: "Amazon EKS",   ns: "tcs-agentic-system", cli: "kubectl" },
  aks:       { name: "Azure AKS",    ns: "tcs-agentic-system", cli: "kubectl" },
  gke:       { name: "Google GKE",   ns: "tcs-agentic-system", cli: "kubectl" },
  k8s:       { name: "Kubernetes",   ns: "tcs-agentic-system", cli: "kubectl" },
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
 * @param {string} hubApiToken   - Hub API token for spoke auth
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
  L.push("---", "apiVersion: v1", "kind: Namespace", "metadata:", `  name: ${ns}`, "  labels:", "    app.kubernetes.io/name: agentic-ai-agent", "    app.kubernetes.io/part-of: tcs-agentic-ai", "    app.kubernetes.io/managed-by: openshift-mcp-hub");
  if (platform === "openshift") L.push("  annotations:", '    openshift.io/description: "TCS AI-Native Cluster Agent"');
  L.push("");

  // ServiceAccount
  L.push("---", "apiVersion: v1", "kind: ServiceAccount", "metadata:", "  name: agentic-ai-agent", `  namespace: ${ns}`, "  labels:", "    app.kubernetes.io/name: agentic-ai-agent");
  if (platform === "eks") L.push("  # Uncomment for IRSA:", "  # annotations:", "  #   eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT:role/agentic-ai-agent");
  else if (platform === "aks") L.push("  # Uncomment for Azure Workload Identity:", "  # annotations:", "  #   azure.workload.identity/client-id: <CLIENT_ID>");
  else if (platform === "gke") L.push("  # Uncomment for GKE Workload Identity:", "  # annotations:", "  #   iam.gke.io/gcp-service-account: agentic-ai-agent@PROJECT.iam.gserviceaccount.com");
  L.push("");

  // ClusterRole — aligned with deploy.sh agentic-ai-agent-reader
  L.push("---", "apiVersion: rbac.authorization.k8s.io/v1", "kind: ClusterRole", "metadata:", "  name: agentic-ai-agent-reader", "  labels:", "    app.kubernetes.io/name: agentic-ai-agent", "rules:");
  // Core read-only (matches deploy.sh exactly)
  L.push('  - apiGroups: [""]', "    resources: [nodes, pods, pods/log, services, namespaces, events, resourcequotas, limitranges, configmaps, secrets, serviceaccounts, persistentvolumeclaims, persistentvolumes, endpoints, replicationcontrollers]", '    verbs: [get, list, watch]');
  L.push('  - apiGroups: [apps]', "    resources: [deployments, replicasets, statefulsets, daemonsets]", '    verbs: [get, list, watch]');
  L.push('  - apiGroups: [batch]', "    resources: [jobs, cronjobs]", '    verbs: [get, list, watch]');
  L.push('  - apiGroups: [autoscaling]', "    resources: [horizontalpodautoscalers]", '    verbs: [get, list, watch]');
  L.push('  - apiGroups: [rbac.authorization.k8s.io]', "    resources: [roles, rolebindings, clusterroles, clusterrolebindings]", '    verbs: [get, list]');
  L.push('  - apiGroups: [networking.k8s.io]', "    resources: [networkpolicies, ingresses, ingressclasses]", '    verbs: [get, list]');
  L.push('  - apiGroups: [policy]', "    resources: [poddisruptionbudgets]", '    verbs: [get, list]');
  L.push('  - apiGroups: [storage.k8s.io]', "    resources: [storageclasses, volumeattachments, csidrivers]", '    verbs: [get, list, watch]');
  L.push('  - apiGroups: [metrics.k8s.io]', "    resources: [nodes, pods]", '    verbs: [get, list]');
  L.push('  - apiGroups: [apiextensions.k8s.io]', "    resources: [customresourcedefinitions]", '    verbs: [get, list]');
  L.push('  - apiGroups: [apiregistration.k8s.io]', "    resources: [apiservices]", '    verbs: [get, list]');
  // Self-update for redeploy
  L.push('  - apiGroups: [apps]', "    resources: [deployments]", "    resourceNames: [agentic-ai-agent]", '    verbs: [patch]');
  L.push('  - apiGroups: [rbac.authorization.k8s.io]', "    resources: [clusterroles]", "    resourceNames: [agentic-ai-agent-reader]", '    verbs: [update, patch]');
  // Third-party observability
  L.push('  - apiGroups: [argoproj.io]', "    resources: [applications, appprojects, applicationsets]", '    verbs: [get, list, watch]');
  L.push('  - apiGroups: [velero.io]', "    resources: [backups, schedules, restores, backupstoragelocations]", '    verbs: [get, list]');
  L.push('  - apiGroups: [aquasecurity.github.io]', "    resources: [vulnerabilityreports, configauditreports]", '    verbs: [get, list]');

  if (platform === "openshift") {
    L.push('  - apiGroups: [config.openshift.io]', "    resources: [clusterversions, clusteroperators, infrastructures, oauths, ingresses, networks, proxies, schedulers, apiservers]", '    verbs: [get, list]');
    L.push('  - apiGroups: [config.openshift.io]', "    resources: [clusterversions]", '    verbs: [patch, update]');
    L.push('  - apiGroups: [route.openshift.io]', "    resources: [routes]", '    verbs: [get, list]');
    L.push('  - apiGroups: [apps.openshift.io]', "    resources: [deploymentconfigs]", '    verbs: [get, list]');
    L.push('  - apiGroups: [project.openshift.io]', "    resources: [projects]", '    verbs: [get, list]');
    L.push('  - apiGroups: [image.openshift.io]', "    resources: [imagestreams, imagestreamtags]", '    verbs: [get, list, watch]');
    L.push('  - apiGroups: [build.openshift.io]', "    resources: [builds, buildconfigs]", '    verbs: [get, list, watch]');
    L.push('  - apiGroups: [security.openshift.io]', "    resources: [securitycontextconstraints]", '    verbs: [get, list]');
    L.push('  - apiGroups: [operators.coreos.com]', "    resources: [subscriptions, clusterserviceversions, installplans, operatorgroups, catalogsources]", '    verbs: [get, list, watch]');
    L.push('  - apiGroups: [operators.coreos.com]', "    resources: [installplans]", '    verbs: [patch, update]');
    L.push('  - apiGroups: [packages.operators.coreos.com]', "    resources: [packagemanifests]", '    verbs: [get, list]');
    L.push('  - apiGroups: [machine.openshift.io]', "    resources: [machines, machinesets, machinehealthchecks]", '    verbs: [get, list]');
    L.push('  - apiGroups: [machineconfiguration.openshift.io]', "    resources: [machineconfigs, machineconfigpools]", '    verbs: [get, list]');
    L.push('  - apiGroups: [monitoring.coreos.com]', "    resources: [prometheuses, alertmanagers, servicemonitors, prometheusrules, podmonitors]", '    verbs: [get, list]');
    L.push('  - apiGroups: [compliance.openshift.io]', "    resources: [compliancesuites, compliancescans, profiles, profilebundles, compliancecheckresults]", '    verbs: [get, list]');
    L.push('  - apiGroups: [user.openshift.io]', "    resources: [users, groups, identities]", '    verbs: [get, list]');
    L.push('  - apiGroups: [quota.openshift.io]', "    resources: [clusterresourcequotas]", '    verbs: [get, list]');
    L.push('  - apiGroups: [tekton.dev]', "    resources: [pipelines, pipelineruns, tasks, taskruns]", '    verbs: [get, list, watch]');
    L.push('  - apiGroups: [authorization.k8s.io]', "    resources: [subjectaccessreviews]", '    verbs: [create]');
    L.push('  - apiGroups: [secscan.quay.redhat.com]', "    resources: [imagemanifestvulns]", '    verbs: [get, list]');
  }
  if (platform === "rancher") {
    L.push('  - apiGroups: [management.cattle.io]', "    resources: [clusters, nodes]", '    verbs: [get, list, watch]');
    L.push('  - apiGroups: [fleet.cattle.io]', "    resources: [bundles, gitrepos]", '    verbs: [get, list]');
  }
  if (platform === "eks") L.push('  - apiGroups: [eks.amazonaws.com]', '    resources: ["*"]', '    verbs: [get, list]');
  if (platform === "gke") L.push('  - apiGroups: [cloud.google.com]', '    resources: ["*"]', '    verbs: [get, list]');
  // Remediation rules (matches deploy.sh)
  L.push('  - apiGroups: [""]', "    resources: [pods]", '    verbs: [delete]');
  L.push('  - apiGroups: [""]', "    resources: [nodes]", '    verbs: [patch, update]');
  L.push('  - apiGroups: [""]', "    resources: [pods/eviction]", '    verbs: [create]');
  L.push('  - apiGroups: [""]', "    resources: [persistentvolumeclaims]", '    verbs: [patch, update]');
  L.push('  - apiGroups: [apps]', "    resources: [deployments, deployments/scale, statefulsets/scale]", '    verbs: [patch, update]');
  L.push('  - apiGroups: [certificates.k8s.io]', "    resources: [certificatesigningrequests/status]", '    verbs: [update]');
  L.push('  - apiGroups: [snapshot.storage.k8s.io]', "    resources: [volumesnapshots]", '    verbs: [create]');
  L.push("");

  // ClusterRoleBinding
  L.push("---", "apiVersion: rbac.authorization.k8s.io/v1", "kind: ClusterRoleBinding", "metadata:", "  name: agentic-ai-agent-reader-binding", "  labels:", "    app.kubernetes.io/name: agentic-ai-agent", "roleRef:", "  apiGroup: rbac.authorization.k8s.io", "  kind: ClusterRole", "  name: agentic-ai-agent-reader", "subjects:", "  - kind: ServiceAccount", "    name: agentic-ai-agent", `    namespace: ${ns}`);
  L.push("");

  // ConfigMap — spoke mode (stateless, no DB)
  L.push("---", "apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: agentic-ai-agent-config", `  namespace: ${ns}`, "  labels:", "    app.kubernetes.io/name: agentic-ai-agent", "data:");
  L.push('  MCP_MODE: "spoke"', '  MCP_TRANSPORT: "sse"', '  MCP_SERVER_PORT: "3000"', '  LOG_LEVEL: "info"', `  HUB_URL: "${serverUrl}"`, `  CLUSTER_NAME: "${safeName}"`, `  CLUSTER_PLATFORM: "${platform}"`, '  DEPLOYMENT_NAME: "agentic-ai-agent"', `  MCP_NAMESPACE: "${ns}"`, '  AUTH_MODE: "none"', '  EMERGENCY_AUTO_FIX: "false"', '  ALLOW_PRIVATE_CLUSTER_IPS: "true"', `  HUB_TLS_SKIP_VERIFY: "true"`, `  ALLOW_REMOTE_ACTIONS: "${allowActions ? "true" : "false"}"`);
  if (apiUrl) L.push(`  API_SERVER_URL: "${apiUrl}"`);
  L.push("");

  // Secret (name matches deploy.sh: agentic-ai-agent-secrets)
  L.push("---", "apiVersion: v1", "kind: Secret", "metadata:", "  name: agentic-ai-agent-secrets", `  namespace: ${ns}`, "  labels:", "    app.kubernetes.io/name: agentic-ai-agent", "type: Opaque", "stringData:", `  MCP_API_TOKEN: ""`, `  HUB_API_TOKEN: "${hubApiToken || ""}"`, `  AGENT_ID: "${safeName}"`);
  L.push("");

  // Deployment — spoke mode (stateless, phones home to hub)
  L.push("---", "apiVersion: apps/v1", "kind: Deployment", "metadata:", "  name: agentic-ai-agent", `  namespace: ${ns}`, "  labels:", "    app.kubernetes.io/name: agentic-ai-agent", "    app.kubernetes.io/component: spoke", "    app.kubernetes.io/part-of: tcs-agentic-ai", "spec:", "  replicas: 1", "  selector:", "    matchLabels:", "      app.kubernetes.io/name: agentic-ai-agent", "  template:", "    metadata:", "      labels:", "        app.kubernetes.io/name: agentic-ai-agent", '        tcs.com/mcp-mode: spoke', `        tcs.com/cluster-name: "${safeName}"`, "    spec:", "      serviceAccountName: agentic-ai-agent");
  // Security context (matches deploy.sh)
  L.push("      securityContext:", "        runAsNonRoot: true", "        seccompProfile:", "          type: RuntimeDefault");
  L.push("      dnsPolicy: None", "      dnsConfig:", "        nameservers:", "          - 10.131.19.154", "        searches:", `          - ${ns}.svc.cluster.local`, "          - svc.cluster.local", "          - cluster.local", "          - caaslab.local", "        options:", "          - name: ndots", '            value: "5"');
  L.push("      containers:", "        - name: agentic-ai-agent", `          image: ${AGENT_IMAGE}`, "          imagePullPolicy: Always", "          ports:", "            - containerPort: 3000", "              name: http", "          envFrom:", "            - configMapRef:", "                name: agentic-ai-agent-config", "            - secretRef:", "                name: agentic-ai-agent-secrets", "          env:", "            - name: NODE_EXTRA_CA_CERTS", '              value: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"', "            - name: NODE_TLS_REJECT_UNAUTHORIZED", '              value: "0"', "            - name: NODE_OPTIONS", '              value: "--max-old-space-size=768"');
  L.push("          resources:", "            requests:", "              cpu: 100m", "              memory: 512Mi", "            limits:", "              cpu: 500m", "              memory: 1Gi");
  L.push("          securityContext:", "            allowPrivilegeEscalation: false", "            readOnlyRootFilesystem: true", "            capabilities:", "              drop:", '                - ALL');
  L.push("          volumeMounts:", "            - name: tmp", "              mountPath: /tmp", "            - name: data", "              mountPath: /data");
  L.push("          readinessProbe:", "            httpGet:", "              path: /readyz", "              port: 3000", "            initialDelaySeconds: 5", "            periodSeconds: 10");
  L.push("          livenessProbe:", "            httpGet:", "              path: /healthz", "              port: 3000", "            initialDelaySeconds: 10", "            periodSeconds: 30");
  L.push("      volumes:", "        - name: tmp", "          emptyDir: {}", "        - name: data", "          emptyDir: {}");
  L.push("");

  // Service
  L.push("---", "apiVersion: v1", "kind: Service", "metadata:", "  name: agentic-ai-agent", `  namespace: ${ns}`, "  labels:", "    app.kubernetes.io/name: agentic-ai-agent", "spec:", "  selector:", "    app.kubernetes.io/name: agentic-ai-agent", "  ports:", "    - port: 3000", "      targetPort: 3000", "      name: http");
  L.push("");

  // Route / Ingress
  if (platform === "openshift") {
    L.push("---", "apiVersion: route.openshift.io/v1", "kind: Route", "metadata:", "  name: agentic-ai-agent", `  namespace: ${ns}`, "  labels:", "    app.kubernetes.io/name: agentic-ai-agent", "  annotations:", "    haproxy.router.openshift.io/timeout: 600s", "    haproxy.router.openshift.io/timeout-tunnel: 600s", "spec:", "  to:", "    kind: Service", "    name: agentic-ai-agent", "  port:", "    targetPort: http", "  tls:", "    termination: edge", "    insecureEdgeTerminationPolicy: Redirect");
  } else {
    L.push("# Uncomment to expose via Ingress:", "# ---", "# apiVersion: networking.k8s.io/v1", "# kind: Ingress", "# metadata:", "#   name: agentic-ai-agent", `#   namespace: ${ns}`);
    if (platform === "eks") L.push("#   annotations:", "#     kubernetes.io/ingress.class: alb");
    else if (platform === "gke") L.push("#   annotations:", "#     kubernetes.io/ingress.class: gce");
    else if (platform === "aks") L.push("#   annotations:", "#     kubernetes.io/ingress.class: azure/application-gateway");
    else L.push("#   annotations:", "#     kubernetes.io/ingress.class: nginx");
    L.push("# spec:", "#   rules:", `#     - host: agentic-ai-agent.${safeName}.local`, "#       http:", "#         paths:", "#           - path: /", "#             pathType: Prefix", "#             backend:", "#               service:", "#                 name: agentic-ai-agent", "#                 port:", "#                   number: 3000");
  }
  L.push("");
  return L.join("\n");
}
