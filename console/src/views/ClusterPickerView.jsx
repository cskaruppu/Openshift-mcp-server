import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import { useAuthStore } from "../store/authStore";
import { useThemeStore } from "../store/themeStore";
import { showToast } from "../store/toastStore";
import { PLATFORM_MAP, getPlatformInfo } from "../lib/platforms";

const PLATFORMS = {
  openshift: { ...PLATFORM_MAP.openshift, ns: "openshift-tcs-agentic", cli: "oc" },
  rancher:   { ...PLATFORM_MAP.rancher,   ns: "tcs-agentic-system",   cli: "kubectl" },
  eks:       { ...PLATFORM_MAP.eks,        ns: "tcs-agentic-system",   cli: "kubectl" },
  aks:       { ...PLATFORM_MAP.aks,        ns: "tcs-agentic-system",   cli: "kubectl" },
  gke:       { ...PLATFORM_MAP.gke,        ns: "tcs-agentic-system",   cli: "kubectl" },
  k8s:       { ...PLATFORM_MAP.k8s,        ns: "tcs-agentic-system",   cli: "kubectl" },
};

function statusDisplay(status) {
  if (status === "live" || status === "active" || status === "connected") return { label: "Active", color: "var(--ok)", pulse: true };
  if (status === "waiting" || status === "registered") return { label: "Awaiting Data", color: "var(--accent2)", pulse: true };
  if (status === "stale") return { label: "Stale", color: "var(--warn)", pulse: false };
  if (status === "unreachable" || status === "error") return { label: "Unreachable", color: "var(--crit)", pulse: false };
  if (status === "auth-error") return { label: "Auth Error", color: "var(--crit)", pulse: false };
  if (status === "pending") return { label: "Agent Not Installed", color: "var(--warn)", pulse: false };
  return { label: status || "Connecting", color: "var(--text2)", pulse: false };
}

function KebabMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="kebab-menu" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className="kebab-btn" onClick={() => setOpen(!open)} title="Cluster actions">&#x22EE;</button>
      {open && (
        <div className="kebab-dropdown open">
          {items.map((item, i) =>
            item.sep ? <div key={i} className="kebab-sep" /> : (
              <button key={i} className={"kebab-item" + (item.danger ? " danger" : "")} onClick={() => { setOpen(false); item.action(); }}>
                <span>{item.icon}</span> {item.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

async function clusterAction(url, method, successMsg, onDone) {
  try {
    const res = await fetch(url, { method: method || "POST" });
    const data = await res.json().catch(() => ({}));
    showToast(data.message || successMsg, res.ok ? "ok" : "err");
    if (res.ok && onDone) onDone();
  } catch (err) {
    showToast("Error: " + err.message, "err");
  }
}

function parseKubeconfig(text) {
  if (!text) return null;
  const t = text.trim();
  if (!t.includes("apiVersion") || (!t.includes("clusters:") && !t.includes("kind: Config"))) return null;
  let server = null, token = null;
  let section = null, inUser = false;
  for (const line of t.split("\n")) {
    const s = line.trim();
    if (/^clusters:\s*$/.test(s)) { section = "clusters"; inUser = false; continue; }
    if (/^users:\s*$/.test(s)) { section = "users"; inUser = false; continue; }
    if (/^(contexts|preferences|apiVersion|kind):/.test(s)) { section = null; continue; }
    if (section === "clusters" && /^server:\s*/.test(s)) {
      server = s.replace(/^server:\s*/, "").replace(/^["']|["']$/g, "");
    }
    if (section === "users") {
      if (/^-\s+name:/.test(s) || /^user:\s*$/.test(s)) { inUser = true; continue; }
      if (inUser && /^token:\s*/.test(s)) {
        token = s.replace(/^token:\s*/, "").replace(/^["']|["']$/g, "");
      }
    }
  }
  return (server || token) ? { server, token } : null;
}

function generateAgentYAML(platform, clusterName, apiUrl, allowActions) {
  const p = PLATFORMS[platform] || PLATFORMS.k8s;
  const ns = p.ns;
  const safeName = (clusterName || "my-cluster").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const serverUrl = location.origin;
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
  L.push(`  HUB_SERVER_URL: "${serverUrl}"`, `  CLUSTER_NAME: "${safeName}"`, `  CLUSTER_PLATFORM: "${platform}"`, '  SCAN_INTERVAL: "60"', '  LOG_LEVEL: "info"', '  HUB_TLS_SKIP_VERIFY: "true"', `  ALLOW_REMOTE_ACTIONS: "${allowActions ? "true" : "false"}"`);
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


// ─── Connect Cluster Modal ──────────────────────────────────────────────
function ConnectClusterModal({ open, onClose, onConnected }) {
  const [step, setStep] = useState("platform"); // platform | form | yaml
  const [platform, setPlatform] = useState(null);
  const [name, setName] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [token, setToken] = useState("");
  const [authTab, setAuthTab] = useState("token"); // token | kubeconfig
  const [allowActions, setAllowActions] = useState(false);
  const [kcParsed, setKcParsed] = useState(null);
  const [status, setStatus] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const fileRef = useRef(null);

  const reset = useCallback(() => {
    setStep("platform"); setPlatform(null); setName(""); setApiUrl("");
    setToken(""); setAuthTab("token"); setAllowActions(false); setKcParsed(null);
    setStatus(null); setConnecting(false);
  }, []);

  useEffect(() => { if (open) reset(); }, [open, reset]);

  const yaml = useMemo(() => {
    if (!platform) return "";
    return generateAgentYAML(platform, name, apiUrl, allowActions);
  }, [platform, name, apiUrl, allowActions]);

  const handleFileUpload = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      setToken(text);
      const parsed = parseKubeconfig(text);
      if (parsed) {
        setKcParsed(parsed);
        if (parsed.server && !apiUrl) setApiUrl(parsed.server);
        showToast("Kubeconfig parsed — server & token extracted", "ok");
      } else {
        showToast("Could not parse kubeconfig — check file format", "err");
      }
    };
    reader.readAsText(file);
  }, [apiUrl]);

  const handleTokenPaste = useCallback((val) => {
    setToken(val);
    const parsed = parseKubeconfig(val);
    if (parsed) {
      setKcParsed(parsed);
      if (parsed.server) setApiUrl(parsed.server);
    } else {
      setKcParsed(null);
    }
  }, []);

  const handleConnect = useCallback(async () => {
    let finalToken = token;
    let finalUrl = apiUrl;
    if (kcParsed) {
      if (kcParsed.server && !finalUrl) finalUrl = kcParsed.server;
      if (kcParsed.token) finalToken = kcParsed.token;
    }
    if (!name.trim()) { setStatus({ type: "err", msg: "Please enter a cluster name" }); return; }
    if (!finalUrl.trim()) { setStatus({ type: "err", msg: "Please enter the API server URL" }); return; }

    setConnecting(true);
    setStatus({ type: "info", msg: "Testing connection to cluster API…" });
    try {
      const res = await fetch("/api/hub/clusters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), platform, apiUrl: finalUrl.trim(), token: finalToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to register cluster");

      if (data.connectionTest?.ok) {
        setStatus({ type: "ok", msg: "Cluster registered and API reachable! Deploy the agent YAML to enable real-time monitoring." });
      } else {
        setStatus({ type: "ok", msg: "Cluster registered! Direct API not available (expected for remote). Deploy the agent YAML to establish the MCP bridge." });
      }
      setStep("yaml");
      if (onConnected) onConnected();
    } catch (err) {
      setStatus({ type: "err", msg: err.message });
    } finally {
      setConnecting(false);
    }
  }, [name, apiUrl, token, platform, kcParsed, onConnected]);

  const downloadYAML = useCallback(() => {
    const blob = new Blob([yaml], { type: "application/x-yaml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tcs-agentic-ai-${platform || "k8s"}.yaml`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [yaml, platform]);

  const copyYAML = useCallback(() => {
    navigator.clipboard.writeText(yaml).then(
      () => showToast("YAML copied to clipboard", "ok"),
      () => showToast("Copy failed", "err")
    );
  }, [yaml]);

  if (!open) return null;

  const pInfo = platform ? PLATFORMS[platform] : null;

  return (
    <div className="ccm-overlay" onClick={onClose}>
      <div className="ccm" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="ccm-header">
          <div className="ccm-header-left">
            {step !== "platform" && (
              <button className="ccm-back" onClick={() => setStep(step === "yaml" ? "form" : "platform")}>←</button>
            )}
            <h2>
              {step === "platform" && "Connect New Cluster"}
              {step === "form" && pInfo && <><span style={{ color: pInfo.color }}>{pInfo.icon}</span>{" "}Connect {pInfo.name} Cluster</>}
              {step === "yaml" && "Agent Deployment YAML"}
            </h2>
          </div>
          <button className="ccm-close" onClick={onClose}>×</button>
        </div>

        {/* Step 1: Platform Selection */}
        {step === "platform" && (
          <div className="ccm-body">
            <p className="ccm-desc">Select the Kubernetes distribution of the cluster you want to connect.</p>
            <div className="ccm-platform-grid">
              {Object.entries(PLATFORMS).map(([key, p]) => (
                <button
                  key={key}
                  className="ccm-platform-card"
                  style={{ "--plat-color": p.color }}
                  onClick={() => { setPlatform(key); setStep("form"); }}
                >
                  <span className="ccm-plat-icon">{p.icon}</span>
                  <span className="ccm-plat-name">{p.name}</span>
                  <span className="ccm-plat-cli">{p.cli}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 2: Connection Form */}
        {step === "form" && (
          <div className="ccm-body">
            <div className="ccm-form">
              <div className="ccm-field">
                <label>Cluster Name</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. production-east" autoFocus />
              </div>
              <div className="ccm-field">
                <label>API Server URL</label>
                <input type="text" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://api.cluster.example.com:6443" />
              </div>

              {/* Auth tabs */}
              <div className="ccm-auth">
                <div className="ccm-auth-tabs">
                  <button className={"ccm-auth-tab" + (authTab === "token" ? " active" : "")} onClick={() => setAuthTab("token")}>Bearer Token</button>
                  <button className={"ccm-auth-tab" + (authTab === "kubeconfig" ? " active" : "")} onClick={() => setAuthTab("kubeconfig")}>Kubeconfig</button>
                </div>

                {authTab === "token" && (
                  <div className="ccm-field">
                    <label>Bearer Token <span className="ccm-optional">(optional — agent uses SA token by default)</span></label>
                    <input type="password" value={token} onChange={(e) => handleTokenPaste(e.target.value)} placeholder="sha256~xxxxxxxxxxxxxxxxxxxxxxxx" />
                  </div>
                )}

                {authTab === "kubeconfig" && (
                  <div className="ccm-kubeconfig">
                    <div className="ccm-field">
                      <label>Upload Kubeconfig File</label>
                      <div className="ccm-file-row">
                        <button className="ccm-file-btn" onClick={() => fileRef.current?.click()}>Choose File</button>
                        <span className="ccm-file-name">{kcParsed ? "Parsed successfully" : "No file selected"}</span>
                        <input ref={fileRef} type="file" accept=".yaml,.yml,.conf,.config,.kubeconfig,*" style={{ display: "none" }} onChange={handleFileUpload} />
                      </div>
                    </div>
                    <div className="ccm-field">
                      <label>Or Paste Kubeconfig YAML</label>
                      <textarea rows={5} value={token} onChange={(e) => handleTokenPaste(e.target.value)} placeholder={"apiVersion: v1\nkind: Config\nclusters:\n  - cluster:\n      server: https://...\nusers:\n  - user:\n      token: sha256~..."} />
                    </div>
                    {kcParsed && (
                      <div className="ccm-kc-banner">
                        <span className="ccm-kc-ok">✓</span>
                        <span>Extracted: server={kcParsed.server || "—"}, token={kcParsed.token ? "present" : "none"}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Allow actions */}
              <label className="ccm-checkbox">
                <input type="checkbox" checked={allowActions} onChange={(e) => setAllowActions(e.target.checked)} />
                <span>Enable remote actions (scale, restart, cordon) from hub AI Chat</span>
              </label>

              {/* Status */}
              {status && (
                <div className={"ccm-status ccm-status-" + status.type}>{status.msg}</div>
              )}

              {/* Actions */}
              <div className="ccm-actions">
                <button className="ccm-connect-btn" onClick={handleConnect} disabled={connecting}>
                  {connecting ? "Connecting…" : "Register & Test Connection"}
                </button>
                <button className="ccm-yaml-btn" onClick={() => setStep("yaml")}>View Agent YAML</button>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: YAML output */}
        {step === "yaml" && (
          <div className="ccm-body">
            {status && (
              <div className={"ccm-status ccm-status-" + status.type} style={{ marginBottom: 12 }}>{status.msg}</div>
            )}
            <div className="ccm-yaml-header">
              <span className="ccm-yaml-filename">tcs-agentic-ai-{platform || "k8s"}.yaml</span>
              <div className="ccm-yaml-actions">
                <button className="ccm-copy-btn" onClick={copyYAML}>Copy</button>
                <button className="ccm-download-btn" onClick={downloadYAML}>Download</button>
              </div>
            </div>
            <pre className="ccm-yaml-block"><code>{yaml}</code></pre>
            <div className="ccm-yaml-instructions">
              <h4>Deploy the agent:</h4>
              <code className="ccm-cmd">{PLATFORMS[platform]?.cli || "kubectl"} apply -f tcs-agentic-ai-{platform || "k8s"}.yaml</code>
              <p>The agent will register with this hub automatically and begin reporting cluster telemetry.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


// ─── Main View ──────────────────────────────────────────────────────────
export function ClusterPickerView({ onSelectCluster, onLogout, onOpenSettings, onOpenAgentRegistry, onOpenUserMgmt }) {
  const user = useAuthStore((s) => s.user);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const queryClient = useQueryClient();
  const [connectOpen, setConnectOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const refetchAgents = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/agent/status"] });
  }, [queryClient]);

  const { data: agentData } = useQuery({
    queryKey: ["/api/agent/status"],
    queryFn: ({ signal }) => apiGet("/api/agent/status", { signal }),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  const { data: hubData } = useQuery({
    queryKey: ["/api/cluster/summary", "local"],
    queryFn: ({ signal }) => apiGet("/api/cluster/summary", { signal }),
    staleTime: 15_000,
  });

  const remoteAgents = Array.isArray(agentData?.agents) ? agentData.agents : [];

  const lci = hubData || {};
  const isOCP = !!lci.isOpenShift;
  const hubPInfo = getPlatformInfo(lci.platform);
  const hubVersion = isOCP ? (lci.cluster?.version || "--") : (lci.cluster?.kubernetesVersion || lci.cluster?.version || "--");
  const hubNodes = lci.nodes ? `${lci.nodes.ready || 0}/${lci.nodes.total || 0}` : "--";
  const hubPods = lci.pods ? `${lci.pods.running ?? 0}` : "--";
  const hubPodsTotal = lci.pods?.total ?? 0;

  const handleConnected = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/agent/status"] });
  }, [queryClient]);

  return (
    <div className="cluster-picker">
      {/* Header */}
      <div className="cp-header">
        <div className="cp-brand">
          <svg viewBox="0 0 44 44" fill="none" width="40" height="40">
            <circle cx="22" cy="22" r="20" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" fill="none"/>
            <clipPath id="cpCircle"><circle cx="22" cy="22" r="16"/></clipPath>
            <g clipPath="url(#cpCircle)" opacity="0.85">
              <line x1="6" y1="2" x2="18" y2="42" stroke="#ef4444" strokeWidth="3.2"/>
              <line x1="11" y1="2" x2="23" y2="42" stroke="#f97316" strokeWidth="3.2"/>
              <line x1="16" y1="2" x2="28" y2="42" stroke="#facc15" strokeWidth="3.2"/>
              <line x1="21" y1="2" x2="33" y2="42" stroke="#22c55e" strokeWidth="3.2"/>
              <line x1="26" y1="2" x2="38" y2="42" stroke="#3b82f6" strokeWidth="3.2"/>
              <line x1="31" y1="2" x2="43" y2="42" stroke="#8b5cf6" strokeWidth="3.2"/>
              <line x1="36" y1="2" x2="48" y2="42" stroke="#ec4899" strokeWidth="3.2"/>
            </g>
            <circle cx="22" cy="22" r="16" stroke="rgba(255,255,255,0.25)" strokeWidth="1.8" fill="none"/>
          </svg>
          <div className="cp-brand-text">
            <span className="cp-brand-name">
              <span className="tcs">TCS</span>{" "}
              <span className="agentic">Agentic</span>{" "}
              <span className="ai">AI</span>
            </span>
            <span className="cp-brand-sub">Enterprise Intelligence Platform</span>
          </div>
        </div>
        <div className="cp-user">
          <div className="cp-header-actions">
            <button className="cp-icon-btn agents-icon-btn" onClick={onOpenAgentRegistry} title="Agent Registry">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="7" r="3" /><circle cx="5" cy="18" r="2.5" /><circle cx="19" cy="18" r="2.5" />
                <line x1="12" y1="10" x2="5" y2="15.5" /><line x1="12" y1="10" x2="19" y2="15.5" />
                <line x1="5" y1="15.5" x2="19" y2="15.5" strokeDasharray="2 2" opacity="0.5" />
              </svg>
              <span className="agents-icon-badge">{remoteAgents.length > 0 ? "!" : ""}</span>
            </button>
            <button className="cp-icon-btn" onClick={onOpenUserMgmt} title="User Management">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </button>
            <button className="cp-icon-btn" onClick={onOpenSettings} title="Settings">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <button className="cp-icon-btn" onClick={toggleTheme} title="Toggle theme">
              <span dangerouslySetInnerHTML={{ __html: theme === "light" ? "&#x2600;" : "&#x263E;" }} />
            </button>
          </div>
          {user && user.name !== "anonymous" && (
            <>
              <span className="cp-user-label">{user.display_name || user.name}</span>
              <button className="cp-logout-btn" onClick={onLogout}>Sign Out</button>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="cp-body">
        <div className="cp-title">Select a Cluster</div>
        <div className="cp-subtitle">Choose a Kubernetes cluster to manage. Each workspace is scoped to the selected cluster.</div>

        <div className="cp-grid">
          {/* Hub cluster card */}
          <div className="cp-card" onClick={() => onSelectCluster("local")}>
            <div className="cp-card-header">
              <div className="cp-card-icon" style={{ background: hubPInfo.color + "15", color: hubPInfo.color }}>
                {hubPInfo.icon}
              </div>
              <div className="cp-card-info">
                <div className="cp-card-name">Hub Cluster <span className="cp-card-primary-badge">PRIMARY</span></div>
                <div className="cp-card-platform">{hubPInfo.name}</div>
              </div>
              <KebabMenu items={[
                { icon: "📊", label: "Open Dashboard", action: () => onSelectCluster("local") },
                { icon: "🔍", label: "Verify Health", action: () => { clusterAction("/api/cluster/health-check", "POST", "Hub health check started"); } },
                { sep: true },
                { icon: "🔒", label: "Sync RBAC", action: () => { clusterAction("/api/cluster/rbac-sync", "POST", "RBAC sync initiated"); } },
              ]} />
            </div>
            <div className="cp-card-status">
              <span className="cp-card-status-dot" style={{ background: "var(--ok)", animation: "pulse 2s infinite" }} />
              <span className="cp-card-status-label" style={{ color: "var(--ok)" }}>Active</span>
            </div>
            <div className="cp-card-stats">
              <div className="cp-card-stat">
                <div className="cp-card-stat-val">{hubVersion}</div>
                <div className="cp-card-stat-lbl">Version</div>
              </div>
              <div className="cp-card-stat">
                <div className="cp-card-stat-val">{hubNodes}</div>
                <div className="cp-card-stat-lbl">Nodes</div>
              </div>
              <div className="cp-card-stat">
                <div className="cp-card-stat-val">{hubPods}</div>
                <div className="cp-card-stat-lbl">Running Pods{hubPodsTotal > 0 ? ` / ${hubPodsTotal}` : ""}</div>
              </div>
            </div>
          </div>

          {/* Remote cluster cards */}
          {remoteAgents.map((agent) => {
            const clusterName = agent.clusterName || agent.name || "unknown";
            const pInfo = getPlatformInfo(agent.platform);
            const st = statusDisplay(agent.status);
            const summary = agent.summary || {};

            const staleClass = (agent.status === "stale") ? " cp-card-stale" : (agent.status === "unreachable" || agent.status === "error") ? " cp-card-unreachable" : "";

            return (
              <div className={"cp-card" + staleClass} key={clusterName} onClick={() => onSelectCluster(clusterName)}>
                <div className="cp-card-header">
                  <div className="cp-card-icon" style={{ background: pInfo.color + "15", color: pInfo.color }}>
                    {pInfo.icon}
                  </div>
                  <div className="cp-card-info">
                    <div className="cp-card-name">{clusterName}</div>
                    <div className="cp-card-platform">{pInfo.name}</div>
                  </div>
                  <KebabMenu items={[
                    { icon: "📊", label: "Status Check", action: () => { clusterAction(`/api/agent/${encodeURIComponent(clusterName)}/status`, "GET", "Status check complete"); } },
                    { icon: "🔍", label: "Verify Health", action: () => { clusterAction(`/api/agent/${encodeURIComponent(clusterName)}/health-check`, "POST", "Health check started"); } },
                    { icon: "✏️", label: "Edit Cluster", action: () => { onOpenSettings(); } },
                    { icon: "↻", label: "Reconnect", action: () => { clusterAction(`/api/agent/${encodeURIComponent(clusterName)}/reconnect`, "POST", "Reconnect initiated"); } },
                    { sep: true },
                    { icon: "🗑", label: "Remove Cluster", danger: true, action: () => setConfirmDelete(clusterName) },
                  ]} />
                </div>
                <div className="cp-card-status">
                  <span className="cp-card-status-dot" style={{
                    background: st.color,
                    animation: st.pulse ? "pulse 2s infinite" : "none"
                  }} />
                  <span className="cp-card-status-label" style={{ color: st.color }}>{st.label}</span>
                  {agent.lastHeartbeat && (agent.status === "stale" || agent.status === "unreachable") && (
                    <span className="cp-card-last-seen">Last seen: {new Date(agent.lastHeartbeat).toLocaleString()}</span>
                  )}
                </div>
                <div className="cp-card-stats">
                  <div className="cp-card-stat">
                    <div className="cp-card-stat-val">{summary.version || agent.version || "--"}</div>
                    <div className="cp-card-stat-lbl">Version</div>
                  </div>
                  <div className="cp-card-stat">
                    <div className="cp-card-stat-val">{summary.nodes || "--"}</div>
                    <div className="cp-card-stat-lbl">Nodes</div>
                  </div>
                  <div className="cp-card-stat">
                    <div className="cp-card-stat-val">{typeof summary.pods === "object" ? (summary.pods.running ?? 0) : (summary.pods ?? "--")}</div>
                    <div className="cp-card-stat-lbl">Running Pods{typeof summary.pods === "object" && summary.pods.total > 0 ? ` / ${summary.pods.total}` : ""}</div>
                  </div>
                </div>
              </div>
            );
          })}

          {/* Add Cluster card */}
          <div className="cp-card-add" onClick={() => setConnectOpen(true)}>
            <div className="cp-card-add-icon">+</div>
            <div className="cp-card-add-label">Connect a Cluster</div>
            <div className="cp-card-add-platforms">
              {Object.values(PLATFORM_MAP).map((p) => (
                <span key={p.name} className="cp-platform-pill" style={{ color: p.color, borderColor: p.color }}>
                  {p.icon} {p.name}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Fleet AI bar */}
        <FleetAIBar />
      </div>

      {/* Connect Cluster Modal */}
      <ConnectClusterModal open={connectOpen} onClose={() => setConnectOpen(false)} onConnected={handleConnected} />

      {/* Delete Confirmation Dialog */}
      {confirmDelete && (
        <div className="cp-confirm-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="cp-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="cp-confirm-icon">
              <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="#ef4444" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="13" /><circle cx="12" cy="16" r="0.5" fill="#ef4444" />
              </svg>
            </div>
            <div className="cp-confirm-title">Remove Cluster</div>
            <div className="cp-confirm-msg">
              Are you sure you want to remove <strong>{confirmDelete}</strong> from the fleet?
              This will unregister the cluster from the hub. The spoke deployment on the remote cluster will not be deleted.
            </div>
            <div className="cp-confirm-actions">
              <button className="cp-confirm-cancel" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="cp-confirm-delete" onClick={() => {
                const name = confirmDelete;
                setConfirmDelete(null);
                Promise.all([
                  fetch(`/api/agent/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => {}),
                  fetch(`/api/spoke/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => {}),
                ]).then(() => {
                  showToast(`Cluster "${name}" removed from fleet`, "ok");
                  refetchAgents();
                });
              }}>Remove Cluster</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FleetAIBar() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState("");
  const [loading, setLoading] = useState(false);

  const ask = async (q) => {
    const text = q || query;
    if (!text.trim()) return;
    setLoading(true);
    setResponse("");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, scope: "fleet" }),
      });
      const data = await res.json();
      setResponse(data.response || data.message || JSON.stringify(data));
    } catch (err) {
      setResponse("Error: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const QUICK = [
    { label: "Health overview", q: "fleet health overview" },
    { label: "Upgrades", q: "which clusters have upgrades available?" },
    { label: "Problem pods", q: "problem pods across all clusters" },
    { label: "Security posture", q: "security posture across the fleet" },
    { label: "Capacity", q: "fleet inventory and capacity" },
  ];

  return (
    <div className={"cp-fleet-bar" + (open ? " open" : "")}>
      <div className="cp-fleet-bar-inner">
        <div className="cp-fleet-bar-header" onClick={() => setOpen(!open)}>
          <div className="cp-fleet-bar-title">
            <span>{"\u{1F30D}"}</span>
            <span className="cp-fleet-label">Fleet AI</span>
            <span className="cp-fleet-badge">ALL CLUSTERS</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="cp-fleet-bar-hint">Ask across every connected cluster</span>
            <span className="cp-fleet-bar-chevron">{"▼"}</span>
          </div>
        </div>
        {open && (
          <div className="cp-fleet-bar-body" style={{ display: "block" }}>
            <div className="cp-fleet-input-row">
              <input
                type="text"
                className="cp-fleet-input"
                placeholder="e.g. which clusters have upgrades available?"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && ask()}
              />
              <button className="cp-fleet-btn" onClick={() => ask()} disabled={loading}>
                {loading ? "Thinking…" : "Ask Fleet"}
              </button>
            </div>
            <div className="cp-fleet-chips">
              {QUICK.map((c) => (
                <button key={c.label} className="fleet-chip" onClick={() => { setQuery(c.q); ask(c.q); }}>
                  {c.label}
                </button>
              ))}
            </div>
            {response && (
              <div className="cp-fleet-response" style={{ display: "block", marginTop: 12, whiteSpace: "pre-wrap" }}>
                {response}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
