import { useState, useRef, useEffect, useCallback, useMemo, Component } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import { useAuthStore } from "../store/authStore";
import { useThemeStore } from "../store/themeStore";
import { showToast } from "../store/toastStore";
import { PLATFORM_MAP, getPlatformInfo } from "../lib/platforms";
import { renderMarkdown } from "../utils/markdown";

class ModalErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(err, info) { console.error("[ConnectClusterModal]", err, info?.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return createPortal(
      <div className="ccm-overlay" onClick={this.props.onClose}>
        <div className="ccm" onClick={(e) => e.stopPropagation()} style={{ padding: 32, textAlign: "center" }}>
          <h3 style={{ color: "#ef4444", marginBottom: 12 }}>Modal Error</h3>
          <p style={{ color: "#94a3b8", fontSize: 13, marginBottom: 12 }}>Something went wrong while rendering the cluster connection form.</p>
          <pre style={{ background: "#1e293b", color: "#f8fafc", padding: 12, borderRadius: 8, fontSize: 11, textAlign: "left", overflow: "auto", maxHeight: 120 }}>
            {this.state.error?.message || "Unknown error"}
          </pre>
          <div style={{ marginTop: 16, display: "flex", gap: 10, justifyContent: "center" }}>
            <button onClick={() => this.setState({ error: null })} style={{ padding: "8px 20px", background: "#6366f1", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 600 }}>
              Try Again
            </button>
            <button onClick={this.props.onClose} style={{ padding: "8px 20px", background: "transparent", color: "#94a3b8", border: "1px solid #334155", borderRadius: 8, cursor: "pointer", fontWeight: 600 }}>
              Close
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  }
}

const PLATFORMS = {
  openshift: { ...PLATFORM_MAP.openshift, ns: "openshift-mcp", cli: "oc" },
  rancher:   { ...PLATFORM_MAP.rancher,   ns: "openshift-mcp", cli: "kubectl" },
  eks:       { ...PLATFORM_MAP.eks,        ns: "openshift-mcp", cli: "kubectl" },
  aks:       { ...PLATFORM_MAP.aks,        ns: "openshift-mcp", cli: "kubectl" },
  gke:       { ...PLATFORM_MAP.gke,        ns: "openshift-mcp", cli: "kubectl" },
  k8s:       { ...PLATFORM_MAP.k8s,        ns: "openshift-mcp", cli: "kubectl" },
};

const AGENT_IMAGE = "quay.io/karuppucs/openshift-mcp-server:latest";

function statusDisplay(status) {
  if (status === "live" || status === "active" || status === "connected") return { label: "Active", color: "var(--ok)", pulse: true };
  if (status === "waiting" || status === "registered") return { label: "Awaiting Data", color: "var(--accent2)", pulse: true };
  if (status === "stale") return { label: "Stale", color: "var(--warn)", pulse: false };
  if (status === "unreachable" || status === "error") return { label: "Unreachable", color: "var(--crit)", pulse: false };
  if (status === "auth-error") return { label: "Auth Error", color: "var(--crit)", pulse: false };
  if (status === "pending") return { label: "Agent Not Installed", color: "var(--warn)", pulse: false };
  return { label: status || "Connecting", color: "var(--text2)", pulse: false };
}

function computeHealthScore(data) {
  if (!data || typeof data !== "object") return { score: 0, label: "--", color: "#64748b" };
  let total = 0, weight = 0;
  const nodes = data.nodes || {};
  if (nodes.total > 0) {
    total += ((nodes.ready || 0) / nodes.total) * 100 * 40;
    weight += 40;
  }
  const ops = data.operators || {};
  if (ops.total > 0) {
    total += ((ops.healthy || 0) / ops.total) * 100 * 40;
    weight += 40;
  }
  const pods = data.pods || {};
  if (pods.total > 0) {
    const running = pods.running ?? 0;
    total += (running / pods.total) * 100 * 20;
    weight += 20;
  }
  const score = weight > 0 ? Math.round(total / weight) : 0;
  const color = score >= 90 ? "#22c55e" : score >= 70 ? "#f59e0b" : "#ef4444";
  const label = score >= 90 ? "Healthy" : score >= 70 ? "Warning" : "Degraded";
  const bd = { nodes, ops, pods };
  const titleParts = [];
  if (nodes.total > 0) titleParts.push(`Nodes: ${nodes.ready || 0}/${nodes.total} (${Math.round(((nodes.ready||0)/nodes.total)*100)}%) — weight 40%`);
  if (ops.total > 0) titleParts.push(`Operators: ${ops.healthy || 0}/${ops.total} (${Math.round(((ops.healthy||0)/ops.total)*100)}%) — weight 40%`);
  if (pods.total > 0) titleParts.push(`Pods: ${pods.running ?? 0}/${pods.total} (${Math.round(((pods.running??0)/pods.total)*100)}%) — weight 20%`);
  const title = titleParts.length > 0 ? `Health Breakdown:\n${titleParts.join("\n")}` : "";
  return { score, label, color, breakdown: bd, title };
}

function parseNodeStr(str) {
  if (!str || str === "--") return { ready: 0, total: 0 };
  const m = String(str).match(/(\d+)\s*\/\s*(\d+)/);
  return m ? { ready: parseInt(m[1]), total: parseInt(m[2]) } : { ready: 0, total: 0 };
}

function HealthRing({ score, icon, color }) {
  const pct = Math.min(100, Math.max(0, score || 0));
  const r = 23;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;
  const ringColor = pct >= 90 ? "#22c55e" : pct >= 70 ? "#f59e0b" : pct > 0 ? "#ef4444" : "#64748b";
  return (
    <div className="cp-card-health-ring">
      <svg viewBox="0 0 52 52" width="52" height="52">
        <circle cx="26" cy="26" r={r} className="cp-health-track" />
        <circle cx="26" cy="26" r={r} className="cp-health-bar" stroke={ringColor}
          strokeDasharray={circ} strokeDashoffset={offset} />
      </svg>
      <div className="cp-card-icon" style={{ background: color + "15", color }}>
        {icon}
      </div>
    </div>
  );
}

function HealthTooltip({ breakdown }) {
  if (!breakdown) return null;
  const { nodes, ops, pods } = breakdown;
  const pct = (a, b) => b > 0 ? Math.round((a / b) * 100) : null;
  const rows = [];
  if (nodes.total > 0) rows.push({ label: "Nodes", val: `${nodes.ready || 0}/${nodes.total}`, pct: pct(nodes.ready || 0, nodes.total), w: "40%" });
  if (ops.total > 0) rows.push({ label: "Operators", val: `${ops.healthy || 0}/${ops.total}`, pct: pct(ops.healthy || 0, ops.total), w: "40%" });
  if (pods.total > 0) rows.push({ label: "Pods", val: `${pods.running ?? 0}/${pods.total}`, pct: pct(pods.running ?? 0, pods.total), w: "20%" });
  if (rows.length === 0) return null;
  return (
    <div className="cp-health-tooltip">
      {rows.map(r => (
        <div key={r.label} className="cp-ht-row">
          <span className="cp-ht-label">{r.label}</span>
          <span className="cp-ht-val">{r.val}</span>
          <span className="cp-ht-pct" style={{ color: r.pct >= 95 ? "#22c55e" : r.pct >= 80 ? "#f59e0b" : "#ef4444" }}>{r.pct}%</span>
          <span className="cp-ht-weight">{r.w}</span>
        </div>
      ))}
    </div>
  );
}

function AlertBadges({ critical, warning }) {
  if (!critical && !warning) return null;
  return (
    <div className="cp-card-alerts">
      {critical > 0 && <span className="cp-alert-badge crit">{critical} crit</span>}
      {warning > 0 && <span className="cp-alert-badge warn">{warning} warn</span>}
    </div>
  );
}

function UtilBar({ percent, color }) {
  const p = Math.min(100, Math.max(0, percent || 0));
  const barColor = p > 85 ? "#ef4444" : p > 65 ? "#f59e0b" : (color || "#22c55e");
  return (
    <div className="cp-util-bar">
      <div className="cp-util-fill" style={{ width: `${p}%`, background: barColor }} />
    </div>
  );
}

function ConnBadge({ type }) {
  const labels = { direct: "Direct", agent: "Agent", spoke: "Spoke" };
  return <span className={`cp-conn-badge ${type || "spoke"}`}>{labels[type] || "Spoke"}</span>;
}

function KebabMenu({ items }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const dropRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (btnRef.current?.contains(e.target)) return;
      if (dropRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const recalc = () => {
      const rect = btnRef.current.getBoundingClientRect();
      const dropH = Math.min(items.length * 42, 320);
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const top = spaceBelow >= dropH ? rect.bottom + 4 : rect.top - dropH - 4;
      const left = Math.max(8, rect.right - 200);
      setPos({ top, left });
    };
    recalc();
    window.addEventListener("scroll", recalc, true);
    window.addEventListener("resize", recalc);
    return () => { window.removeEventListener("scroll", recalc, true); window.removeEventListener("resize", recalc); };
  }, [open, items.length]);

  const dropdown = open ? createPortal(
    <div ref={dropRef} className="kebab-dropdown open" style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 99999 }}>
      {items.map((item, i) =>
        item.sep ? <div key={i} className="kebab-sep" /> : (
          <button key={i} className={"kebab-item" + (item.danger ? " danger" : "")} onClick={() => { setOpen(false); item.action(); }}>
            <span>{item.icon}</span> {item.label}
          </button>
        )
      )}
    </div>,
    document.body
  ) : null;

  return (
    <div className="kebab-menu" onClick={(e) => e.stopPropagation()}>
      <button ref={btnRef} className="kebab-btn" onClick={() => setOpen(!open)} title="Cluster actions">&#x22EE;</button>
      {dropdown}
    </div>
  );
}

async function clusterAction(url, method, successMsg, onDone) {
  try {
    const res = await fetch(url, { method: method || "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok && onDone) onDone(data);
    return { ok: res.ok, data };
  } catch (err) {
    showToast("Error: " + err.message, "err");
    return { ok: false, error: err.message };
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
  const N = "openshift-mcp-server";

  const L = [];
  L.push("# ============================================================");
  L.push("# TCS Agentic AI — Cluster Agent Deployment");
  L.push(`# Platform : ${p.name}`);
  L.push(`# Cluster  : ${clusterName || safeName}`);
  L.push(`# Registry : ${AGENT_IMAGE}`);
  L.push(`# Generated: ${date}`);
  L.push("# ============================================================");
  L.push("#");
  L.push(`# Apply with: ${p.cli} apply -f ${N}-${platform}.yaml`);
  L.push(`# Remove with: ${p.cli} delete -f ${N}-${platform}.yaml`);
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
  L.push("---", "apiVersion: v1", "kind: Namespace", "metadata:", `  name: ${ns}`, "  labels:", `    app.kubernetes.io/name: ${N}`, `    app.kubernetes.io/part-of: ${N}`, "    app.kubernetes.io/managed-by: openshift-mcp-hub");
  if (platform === "openshift") L.push("  annotations:", '    openshift.io/description: "TCS AI-Native Cluster Agent"');
  L.push("");

  // ServiceAccount
  L.push("---", "apiVersion: v1", "kind: ServiceAccount", "metadata:", `  name: ${N}`, `  namespace: ${ns}`, "  labels:", `    app.kubernetes.io/name: ${N}`);
  if (platform === "eks") L.push("  # Uncomment for IRSA:", "  # annotations:", `  #   eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT:role/${N}`);
  else if (platform === "aks") L.push("  # Uncomment for Azure Workload Identity:", "  # annotations:", "  #   azure.workload.identity/client-id: <CLIENT_ID>");
  else if (platform === "gke") L.push("  # Uncomment for GKE Workload Identity:", "  # annotations:", `  #   iam.gke.io/gcp-service-account: ${N}@PROJECT.iam.gserviceaccount.com`);
  L.push("");

  // ClusterRole
  L.push("---", "apiVersion: rbac.authorization.k8s.io/v1", "kind: ClusterRole", "metadata:", `  name: ${N}-role`, "  labels:", `    app.kubernetes.io/name: ${N}`, "rules:");
  L.push('  - apiGroups: [""]', "    resources: [pods, pods/log, nodes, services, events, namespaces, configmaps, persistentvolumeclaims, endpoints, replicationcontrollers, serviceaccounts, resourcequotas, limitranges]", '    verbs: ["get", "list", "watch"]');
  L.push('  - apiGroups: ["apps"]', "    resources: [deployments, statefulsets, daemonsets, replicasets]", '    verbs: ["get", "list", "watch"]');
  L.push('  - apiGroups: ["apps"]', "    resources: [deployments]", `    resourceNames: [${N}]`, '    verbs: ["patch"]');
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
  L.push('  - apiGroups: ["rbac.authorization.k8s.io"]', "    resources: [clusterroles]", `    resourceNames: [${N}-role]`, '    verbs: ["update", "patch"]');
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
  L.push("---", "apiVersion: rbac.authorization.k8s.io/v1", "kind: ClusterRoleBinding", "metadata:", `  name: ${N}-binding`, "  labels:", `    app.kubernetes.io/name: ${N}`, "roleRef:", "  apiGroup: rbac.authorization.k8s.io", "  kind: ClusterRole", `  name: ${N}-role`, "subjects:", "  - kind: ServiceAccount", `    name: ${N}`, `    namespace: ${ns}`);
  L.push("");

  // ConfigMap
  L.push("---", "apiVersion: v1", "kind: ConfigMap", "metadata:", `  name: ${N}-config`, `  namespace: ${ns}`, "  labels:", `    app.kubernetes.io/name: ${N}`, "data:");
  L.push(`  HUB_SERVER_URL: "${serverUrl}"`, `  CLUSTER_NAME: "${safeName}"`, `  CLUSTER_PLATFORM: "${platform}"`, `  DEPLOYMENT_NAME: "${N}"`, '  SCAN_INTERVAL: "60"', '  LOG_LEVEL: "info"', '  HUB_TLS_SKIP_VERIFY: "true"', `  ALLOW_REMOTE_ACTIONS: "${allowActions ? "true" : "false"}"`);
  if (apiUrl) L.push(`  API_SERVER_URL: "${apiUrl}"`);
  L.push("");

  // Secret
  L.push("---", "apiVersion: v1", "kind: Secret", "metadata:", `  name: ${N}-secret`, `  namespace: ${ns}`, "  labels:", `    app.kubernetes.io/name: ${N}`, "type: Opaque", "stringData:", "  # Agent uses in-cluster ServiceAccount token by default.", '  # Uncomment to override:', '  # BEARER_TOKEN: "sha256~xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"', `  AGENT_ID: "${safeName}"`);
  L.push("");

  // Deployment
  L.push("---", "apiVersion: apps/v1", "kind: Deployment", "metadata:", `  name: ${N}`, `  namespace: ${ns}`, "  labels:", `    app: ${N}`, `    app.kubernetes.io/name: ${N}`, '    app.kubernetes.io/version: "1.2.0"', "spec:", "  replicas: 1", "  revisionHistoryLimit: 3", "  strategy:", "    type: RollingUpdate", "    rollingUpdate:", "      maxUnavailable: 0", "      maxSurge: 1", "  selector:", "    matchLabels:", `      app: ${N}`, "  template:", "    metadata:", "      labels:", `        app: ${N}`, `        app.kubernetes.io/name: ${N}`, "      annotations:", '        prometheus.io/scrape: "true"', '        prometheus.io/port: "8080"', '        prometheus.io/path: "/status"', "    spec:", `      serviceAccountName: ${N}`);
  if (platform === "openshift") L.push("      securityContext:", "        runAsNonRoot: true");
  else L.push("      securityContext:", "        runAsNonRoot: true", "        runAsUser: 1001", "        runAsGroup: 1001", "        fsGroup: 1001");
  L.push("      terminationGracePeriodSeconds: 30", "      containers:", "        - name: agent", `          image: ${AGENT_IMAGE}`, "          imagePullPolicy: Always", "          env:", "            - name: NODE_EXTRA_CA_CERTS", "              value: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt", "            - name: NODE_TLS_REJECT_UNAUTHORIZED", '              value: "0"', "          envFrom:", "            - configMapRef:", `                name: ${N}-config`, "            - secretRef:", `                name: ${N}-secret`, "                optional: true", "          ports:", "            - containerPort: 8080", "              name: http", "              protocol: TCP", "          resources:", "            requests:", "              cpu: 50m", "              memory: 64Mi", "            limits:", "              cpu: 200m", "              memory: 128Mi");
  L.push("          livenessProbe:", "            httpGet:", "              path: /healthz", "              port: 8080", "            initialDelaySeconds: 10", "            periodSeconds: 30", "            timeoutSeconds: 5", "            failureThreshold: 3");
  L.push("          readinessProbe:", "            httpGet:", "              path: /readyz", "              port: 8080", "            initialDelaySeconds: 5", "            periodSeconds: 10", "            timeoutSeconds: 3", "            failureThreshold: 2");
  L.push("          securityContext:", "            allowPrivilegeEscalation: false", "            capabilities:", "              drop:", "                - ALL");
  L.push("");

  // Service
  L.push("---", "apiVersion: v1", "kind: Service", "metadata:", `  name: ${N}`, `  namespace: ${ns}`, "  labels:", `    app: ${N}`, "spec:", "  type: ClusterIP", "  selector:", `    app: ${N}`, "  ports:", "    - port: 8080", "      targetPort: 8080", "      protocol: TCP", "      name: http");
  L.push("");

  // Route / Ingress
  if (platform === "openshift") {
    L.push("---", "apiVersion: route.openshift.io/v1", "kind: Route", "metadata:", `  name: ${N}`, `  namespace: ${ns}`, "  labels:", `    app: ${N}`, "spec:", "  to:", "    kind: Service", `    name: ${N}`, "  port:", "    targetPort: http", "  tls:", "    termination: edge", "    insecureEdgeTerminationPolicy: Redirect");
  } else {
    L.push("# Uncomment to expose via Ingress:", "# ---", "# apiVersion: networking.k8s.io/v1", "# kind: Ingress", "# metadata:", `#   name: ${N}`, `#   namespace: ${ns}`);
    if (platform === "eks") L.push("#   annotations:", "#     kubernetes.io/ingress.class: alb");
    else if (platform === "gke") L.push("#   annotations:", "#     kubernetes.io/ingress.class: gce");
    else if (platform === "aks") L.push("#   annotations:", "#     kubernetes.io/ingress.class: azure/application-gateway");
    else L.push("#   annotations:", "#     kubernetes.io/ingress.class: nginx");
    L.push("# spec:", "#   rules:", `#     - host: ${N}.${safeName}.local`, "#       http:", "#         paths:", "#           - path: /", "#             pathType: Prefix", "#             backend:", "#               service:", `#                 name: ${N}`, "#                 port:", "#                   number: 8080");
  }
  L.push("");
  return L.join("\n");
}


// ─── Connect Cluster Modal ──────────────────────────────────────────────
function ConnectClusterModal({ open, onClose, onConnected, editCluster }) {
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
  const [agentStatus, setAgentStatus] = useState(null); // null | "polling" | "live" | "registered" | "error"
  const [agentDetail, setAgentDetail] = useState("");
  const pollRef = useRef(null);
  const isEdit = !!editCluster;
  const fileRef = useRef(null);

  useEffect(() => {
    if (step !== "yaml" || !name.trim()) { setAgentStatus(null); return; }
    setAgentStatus("polling");
    setAgentDetail("Waiting for agent to connect...");
    let cancelled = false;
    const safeName = name.trim().replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
    const poll = async () => {
      try {
        const res = await fetch("/api/agent/status");
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const agents = data.agents || data || [];
        const match = agents.find(a => a.name === safeName || a.clusterName === safeName);
        if (!match) {
          setAgentStatus("polling");
          setAgentDetail("Agent not yet detected. Deploy the YAML and wait...");
          return;
        }
        const s = match.status || match.state;
        if (s === "live" || s === "active" || s === "connected") {
          setAgentStatus("live");
          setAgentDetail("Agent connected and reporting! Cluster is active.");
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        } else if (s === "registered" || s === "waiting") {
          setAgentStatus("registered");
          setAgentDetail("Cluster registered. Waiting for agent pod to start and connect...");
        } else if (s === "stale") {
          setAgentStatus("registered");
          setAgentDetail("Agent heartbeat stale. Check if the pod is running.");
        } else {
          setAgentStatus("registered");
          setAgentDetail(`Agent status: ${s}. Waiting for connection...`);
        }
      } catch { if (!cancelled) { setAgentStatus("polling"); setAgentDetail("Checking agent status..."); } }
    };
    poll();
    pollRef.current = setInterval(poll, 5000);
    return () => { cancelled = true; if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [step, name]);

  const reset = useCallback(() => {
    if (editCluster) {
      setStep("form");
      setPlatform(editCluster.platform || "k8s");
      setName(editCluster.name || "");
      setApiUrl(editCluster.apiUrl || "");
      setToken("");
      setAuthTab("token");
      setAllowActions(false);
      setKcParsed(null);
      setStatus(null);
      setConnecting(false);
    } else {
      setStep("platform"); setPlatform(null); setName(""); setApiUrl("");
      setToken(""); setAuthTab("token"); setAllowActions(false); setKcParsed(null);
      setStatus(null); setConnecting(false);
    }
  }, [editCluster]);

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
    a.download = `openshift-mcp-server-${platform || "k8s"}.yaml`;
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

  const STEP_LIST = [
    { id: "platform", num: 1, label: "Platform" },
    { id: "form", num: 2, label: "Configure" },
    { id: "review", num: 3, label: "Review" },
    { id: "yaml", num: 4, label: "Deploy" },
  ];
  const stepIdx = STEP_LIST.findIndex(s => s.id === step);

  const goBack = () => {
    if (step === "yaml") setStep("review");
    else if (step === "review") setStep("form");
    else if (step === "form") setStep("platform");
  };

  const hubUrl = window.location.origin;
  const cliTool = PLATFORMS[platform]?.cli || "kubectl";
  const safeClusterName = (name || "cluster").replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const curlCmd = `curl -sL ${hubUrl}/api/agent/yaml/${encodeURIComponent(safeClusterName)} | ${cliTool} apply -f -`;

  const copyCurl = useCallback(() => {
    navigator.clipboard.writeText(curlCmd).then(
      () => showToast("Command copied to clipboard", "ok"),
      () => showToast("Copy failed", "err")
    );
  }, [curlCmd]);

  // Portal to document.body — the `.cluster-picker > *` rule forces
  // `position: relative; z-index: 1` on direct children, trapping this
  // fixed-position overlay in a low stacking context. Portal escapes it.
  const portalTarget = typeof document !== "undefined" ? document.body : null;
  if (!portalTarget) return null;

  return createPortal(
    <div className="ccm-overlay" onClick={onClose}>
      <div className="ccm" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="ccm-header">
          <div className="ccm-header-left">
            {step !== "platform" && (
              <button className="ccm-back" onClick={goBack}>←</button>
            )}
            <h2>
              {step === "platform" && "Connect New Cluster"}
              {step === "form" && pInfo && <><span style={{ color: pInfo.color }}>{pInfo.icon}</span>{" "}{isEdit ? "Edit" : "Connect"} {pInfo.name} Cluster</>}
              {step === "review" && "Review Configuration"}
              {step === "yaml" && "Deploy Agent"}
            </h2>
          </div>
          <button className="ccm-close" onClick={onClose}>×</button>
        </div>

        {/* Step Progress Bar */}
        <div className="ccm-steps">
          {STEP_LIST.map((s, i) => {
            const done = i < stepIdx;
            const active = i === stepIdx;
            return (
              <div key={s.id} className={"ccm-step" + (done ? " done" : "") + (active ? " active" : "")}>
                <div className="ccm-step-circle">{done ? "✓" : s.num}</div>
                <span className="ccm-step-label">{s.label}</span>
                {i < STEP_LIST.length - 1 && <div className={"ccm-step-line" + (done ? " done" : "")} />}
              </div>
            );
          })}
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
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. production-east" autoFocus readOnly={isEdit} style={isEdit ? { opacity: .6, cursor: "not-allowed" } : undefined} />
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

              {/* Actions */}
              <div className="ccm-actions">
                <button className="ccm-connect-btn" onClick={() => { if (!name.trim()) { setStatus({ type: "err", msg: "Please enter a cluster name" }); return; } setStep("review"); }}>
                  Next: Review
                </button>
              </div>

              {status && (
                <div className={"ccm-status ccm-status-" + status.type}>{status.msg}</div>
              )}
            </div>
          </div>
        )}

        {/* Step 3: Review */}
        {step === "review" && (
          <div className="ccm-body">
            <div className="ccm-review">
              <div className="ccm-review-card">
                <div className="ccm-review-header">
                  {pInfo && <span style={{ fontSize: 28 }}>{pInfo.icon}</span>}
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 16 }}>{name || "—"}</div>
                    <div style={{ fontSize: 12, color: "var(--text2)" }}>{pInfo?.name || platform} Cluster</div>
                  </div>
                </div>
                <div className="ccm-review-grid">
                  <div className="ccm-review-item">
                    <span className="ccm-review-label">Platform</span>
                    <span className="ccm-review-value" style={{ color: pInfo?.color }}>{pInfo?.name || platform}</span>
                  </div>
                  <div className="ccm-review-item">
                    <span className="ccm-review-label">API Server</span>
                    <span className="ccm-review-value" style={{ fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: 11 }}>{apiUrl || "Auto-detect via agent"}</span>
                  </div>
                  <div className="ccm-review-item">
                    <span className="ccm-review-label">Authentication</span>
                    <span className="ccm-review-value">{token ? (kcParsed ? "Kubeconfig" : "Bearer Token") : "ServiceAccount (in-cluster)"}</span>
                  </div>
                  <div className="ccm-review-item">
                    <span className="ccm-review-label">Remote Actions</span>
                    <span className="ccm-review-value" style={{ color: allowActions ? "var(--ok)" : "var(--text2)" }}>{allowActions ? "Enabled" : "Disabled"}</span>
                  </div>
                  <div className="ccm-review-item">
                    <span className="ccm-review-label">CLI Tool</span>
                    <span className="ccm-review-value" style={{ fontFamily: "'SF Mono', 'Fira Code', monospace" }}>{cliTool}</span>
                  </div>
                  <div className="ccm-review-item">
                    <span className="ccm-review-label">Agent Namespace</span>
                    <span className="ccm-review-value" style={{ fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: 11 }}>{PLATFORMS[platform]?.ns || "openshift-mcp"}</span>
                  </div>
                </div>

                <div className="ccm-review-what">
                  <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6, color: "var(--text)" }}>What will be created:</div>
                  <div className="ccm-review-resources">
                    <span>Namespace</span><span>ServiceAccount</span><span>ClusterRole</span><span>ClusterRoleBinding</span>
                    <span>ConfigMap</span><span>Secret</span><span>Deployment</span><span>Service</span>
                    {platform === "openshift" && <span>Route</span>}
                  </div>
                </div>
              </div>

              {status && (
                <div className={"ccm-status ccm-status-" + status.type} style={{ marginTop: 12 }}>{status.msg}</div>
              )}

              <div className="ccm-actions" style={{ marginTop: 16 }}>
                <button className="ccm-connect-btn" onClick={handleConnect} disabled={connecting}>
                  {connecting ? "Registering…" : isEdit ? "Update & Register" : "Register Cluster"}
                </button>
                <button className="ccm-yaml-btn" onClick={() => setStep("yaml")}>Skip to YAML</button>
              </div>
            </div>
          </div>
        )}

        {/* Step 4: Deploy Agent */}
        {step === "yaml" && (
          <div className="ccm-body">
            {status && (
              <div className={"ccm-status ccm-status-" + status.type} style={{ marginBottom: 12 }}>{status.msg}</div>
            )}

            {/* Quick Deploy — curl one-liner */}
            <div className="ccm-deploy-section">
              <div className="ccm-deploy-header">
                <span style={{ fontSize: 16 }}>&#9889;</span>
                <span style={{ fontWeight: 700, fontSize: 14 }}>Quick Deploy (One Command)</span>
              </div>
              <p className="ccm-deploy-desc">Run this on the target cluster to download and apply the agent YAML in one step:</p>
              <div className="ccm-curl-box">
                <code>{curlCmd}</code>
                <button className="ccm-curl-copy" onClick={copyCurl} title="Copy command">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                </button>
              </div>
            </div>

            {/* OR separator */}
            <div className="ccm-or-divider"><span>OR</span></div>

            {/* Manual Deploy — download/copy YAML */}
            <div className="ccm-deploy-section">
              <div className="ccm-deploy-header">
                <span style={{ fontSize: 16 }}>&#128196;</span>
                <span style={{ fontWeight: 700, fontSize: 14 }}>Manual Deploy</span>
              </div>
              <div className="ccm-yaml-header">
                <span className="ccm-yaml-filename">openshift-mcp-server-{platform || "k8s"}.yaml</span>
                <div className="ccm-yaml-actions">
                  <button className="ccm-copy-btn" onClick={copyYAML}>Copy YAML</button>
                  <button className="ccm-download-btn" onClick={downloadYAML}>Download</button>
                </div>
              </div>
              <pre className="ccm-yaml-block" style={{ maxHeight: 220 }}><code>{yaml}</code></pre>
              <div className="ccm-yaml-instructions">
                <h4>Then apply:</h4>
                <code className="ccm-cmd">{cliTool} apply -f openshift-mcp-server-{platform || "k8s"}.yaml</code>
              </div>
            </div>

            {/* Live Agent Status Tracker */}
            <div className="ccm-agent-tracker">
              <div className="ccm-tracker-header">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                <span style={{ fontWeight: 700, fontSize: 14 }}>Agent Connection Status</span>
              </div>
              <div className="ccm-tracker-steps">
                <div className={"ccm-tracker-step" + (agentStatus ? " done" : " active")}>
                  <span className={"ccm-tracker-dot" + (agentStatus ? " dot-ok" : " dot-pulse")} />
                  <span>Cluster registered in hub</span>
                </div>
                <div className={"ccm-tracker-step" + (agentStatus === "live" ? " done" : agentStatus === "registered" ? " active" : "")}>
                  <span className={"ccm-tracker-dot" + (agentStatus === "live" ? " dot-ok" : agentStatus === "registered" ? " dot-pulse" : "")} />
                  <span>Agent pod deployed &amp; reporting</span>
                </div>
                <div className={"ccm-tracker-step" + (agentStatus === "live" ? " done" : "")}>
                  <span className={"ccm-tracker-dot" + (agentStatus === "live" ? " dot-ok" : "")} />
                  <span>Full telemetry active</span>
                </div>
              </div>
              <div className={"ccm-tracker-msg ccm-tracker-" + (agentStatus || "polling")}>
                {agentStatus === "live" && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>}
                {agentStatus === "polling" && <span className="ccm-tracker-spinner" />}
                {agentStatus === "registered" && <span className="ccm-tracker-spinner" />}
                <span>{agentDetail}</span>
              </div>
              {agentStatus === "live" && (
                <button className="ccm-tracker-done" onClick={onClose}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
                  Done — Go to Dashboard
                </button>
              )}
            </div>

            {/* What happens next */}
            {agentStatus !== "live" && (
            <div className="ccm-next-steps">
              <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8 }}>What happens next:</div>
              <div className="ccm-next-list">
                <div className="ccm-next-item"><span className="ccm-next-num">1</span><span>Agent pod starts in the target cluster</span></div>
                <div className="ccm-next-item"><span className="ccm-next-num">2</span><span>Connects back to this hub via WebSocket</span></div>
                <div className="ccm-next-item"><span className="ccm-next-num">3</span><span>Cluster card turns <strong style={{ color: "var(--ok)" }}>Active</strong> within 60 seconds</span></div>
                <div className="ccm-next-item"><span className="ccm-next-num">4</span><span>Full telemetry, AI Chat, and Fleet AI available</span></div>
              </div>
            </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}


// ─── Main View ──────────────────────────────────────────────────────────
export function ClusterPickerView({ onSelectCluster, onLogout, onOpenSettings, onOpenAgentRegistry, onOpenUserMgmt }) {
  const user = useAuthStore((s) => s.user);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const queryClient = useQueryClient();
  const [connectOpen, setConnectOpen] = useState(false);
  const [editCluster, setEditCluster] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [actionResult, setActionResult] = useState(null); // { title, cluster, loading, data, error }

  const refetchAgents = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/agent/status"] });
  }, [queryClient]);

  const { data: agentData } = useQuery({
    queryKey: ["/api/agent/status"],
    queryFn: ({ signal }) => apiGet("/api/agent/status", { signal }),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  const { data: hubData, isError: hubError } = useQuery({
    queryKey: ["/api/cluster/summary", "local"],
    queryFn: ({ signal }) => apiGet("/api/cluster/summary", { signal }),
    staleTime: 15_000,
    retry: 1,
  });

  const remoteAgents = Array.isArray(agentData?.agents) ? agentData.agents : [];
  const hubMcpVersion = agentData?.hubVersion || null;
  // Prefer the control plane's explicit signal; fall back to summary success
  // for older server builds that don't send hubAgentDeployed.
  const hubAgentDeployed = agentData?.hubAgentDeployed !== undefined
    ? !!agentData.hubAgentDeployed
    : (!!hubData && !hubError);

  const lci = hubData || {};
  const isOCP = !!lci.isOpenShift;
  const hubPInfo = hubAgentDeployed ? getPlatformInfo(lci.platform) : getPlatformInfo(null);
  const hubVersion = hubAgentDeployed ? (isOCP ? (lci.cluster?.version || "--") : (lci.cluster?.kubernetesVersion || lci.cluster?.version || "--")) : "--";
  const hubNodes = hubAgentDeployed && lci.nodes ? `${lci.nodes.ready || 0}/${lci.nodes.total || 0}` : "--";
  const hubHealthData = hubAgentDeployed ? computeHealthScore({ nodes: lci.nodes, operators: lci.operators, pods: lci.pods }) : { score: 0, label: "--", color: "#64748b" };

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

        {!hubAgentDeployed && (
          <div style={{ maxWidth: 720, margin: "0 auto 20px", padding: "12px 18px", borderRadius: 10, background: "color-mix(in srgb, #6366f1 8%, transparent)", border: "1px solid color-mix(in srgb, #6366f1 25%, transparent)", fontSize: 13, color: "var(--text)", textAlign: "center" }}>
            <strong>This cluster's MCP agent is not deployed.</strong> Clusters appear here only when their agent pod is running and reporting live data.
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--text2)" }}>
              Run <code style={{ background: "var(--surface2)", padding: "2px 8px", borderRadius: 4, fontSize: 11 }}>./deploy/mcp/deploy.sh --cluster-name hub-cluster</code> on this cluster to activate it.
            </div>
          </div>
        )}

        <div className={"cp-grid" + (!hubAgentDeployed && remoteAgents.length === 0 ? " cp-grid-empty" : "")}>
          {/* Hub cluster card — rendered only when this cluster's MCP agent pod
              is running and reporting, exactly like remote cluster cards. */}
          {hubAgentDeployed && (
          <div className="cp-card" onClick={() => onSelectCluster("local")}>
            <div className="cp-card-header">
              <HealthRing score={hubHealthData.score} icon={hubPInfo.icon} color={hubPInfo.color} />
              <div className="cp-card-info">
                <div className="cp-card-name">Hub Cluster <span className="cp-card-primary-badge">PRIMARY</span></div>
                <div className="cp-card-platform">{hubPInfo.name}<ConnBadge type="direct" /></div>
              </div>
              <KebabMenu items={[
                { icon: "📊", label: "Status Check", action: async () => {
                  setActionResult({ title: "Status Check", cluster: "Hub Cluster", loading: true });
                  const r = await clusterAction("/api/cluster/summary", "GET");
                  setActionResult(prev => ({ ...prev, loading: false, data: r.ok ? r.data : null, error: r.ok ? null : (r.data?.error || r.error || "Failed") }));
                }},
                { icon: "🔍", label: "Verify Health", action: async () => {
                  setActionResult({ title: "Verify Health", cluster: "Hub Cluster", loading: true });
                  const r = await clusterAction("/api/cluster/health-check", "POST");
                  setActionResult(prev => ({ ...prev, loading: false, data: r.ok ? r.data : null, error: r.ok ? null : (r.data?.error || r.error || "Failed") }));
                }},
                { icon: "🚀", label: "Redeploy", action: async () => {
                  if (!window.confirm("Trigger a rollout restart on the Hub Cluster agent?\n\nThis will restart the agent pod.")) return;
                  setActionResult({ title: "Redeploy", cluster: "Hub Cluster", loading: true });
                  const r = await clusterAction("/api/cluster/redeploy", "POST");
                  setActionResult(prev => ({ ...prev, loading: false, data: r.ok ? r.data : null, error: r.ok ? null : (r.data?.error || r.error || "Failed") }));
                  if (r.ok) refetchAgents();
                }},
                { icon: "✏️", label: "Edit Settings", action: () => { onOpenSettings(); } },
                { sep: true },
                { icon: "🔒", label: "Sync RBAC", action: async () => {
                  setActionResult({ title: "Sync RBAC", cluster: "Hub Cluster", loading: true });
                  const r = await clusterAction("/api/cluster/rbac-sync", "POST");
                  setActionResult(prev => ({ ...prev, loading: false, data: r.ok ? r.data : null, error: r.ok ? null : (r.data?.error || r.error || "Failed") }));
                }},
                { sep: true },
                { icon: "🗑", label: "Remove Cluster", danger: true, action: () => setConfirmDelete("hub-cluster") },
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
              <div className="cp-card-stat cp-health-stat" title={hubHealthData.title} onClick={e => e.stopPropagation()}>
                <div className="cp-card-stat-val" style={{ color: hubHealthData.color }}>{hubHealthData.score}%</div>
                <div className="cp-card-stat-lbl">{hubHealthData.label}</div>
                <HealthTooltip breakdown={hubHealthData.breakdown} />
              </div>
            </div>
          </div>
          )}

          {/* Remote cluster cards */}
          {remoteAgents.map((agent) => {
            const clusterName = agent.clusterName || agent.name || "unknown";
            const pInfo = getPlatformInfo(agent.platform);
            const st = statusDisplay(agent.status);
            const summary = agent.summary || {};
            const parsedNodes = parseNodeStr(summary.nodes);
            const remoteHealthData = computeHealthScore({
              nodes: parsedNodes,
              operators: summary.operators,
              pods: typeof summary.pods === "object" ? summary.pods : { running: summary.pods || 0, total: summary.pods || 0 },
            });

            const staleClass = (agent.status === "stale") ? " cp-card-stale" : (agent.status === "unreachable" || agent.status === "error") ? " cp-card-unreachable" : "";

            return (
              <div className={"cp-card" + staleClass} key={clusterName} onClick={() => onSelectCluster(clusterName)}>
                <div className="cp-card-header">
                  <HealthRing score={remoteHealthData.score} icon={pInfo.icon} color={pInfo.color} />
                  <div className="cp-card-info">
                    <div className="cp-card-name">{clusterName}</div>
                    <div className="cp-card-platform">{pInfo.name}<ConnBadge type={summary.connectionType || "spoke"} /></div>
                  </div>
                  <KebabMenu items={[
                    { icon: "📊", label: "Status Check", action: async () => {
                      setActionResult({ title: "Status Check", cluster: clusterName, loading: true });
                      const r = await clusterAction(`/api/agent/${encodeURIComponent(clusterName)}/status`, "GET");
                      setActionResult(prev => ({ ...prev, loading: false, data: r.ok ? r.data : null, error: r.ok ? null : (r.data?.error || r.error || "Failed") }));
                    }},
                    { icon: "🔍", label: "Verify Health", action: async () => {
                      setActionResult({ title: "Verify Health", cluster: clusterName, loading: true });
                      const r = await clusterAction(`/api/agent/${encodeURIComponent(clusterName)}/health-check`, "POST");
                      setActionResult(prev => ({ ...prev, loading: false, data: r.ok ? r.data : null, error: r.ok ? null : (r.data?.error || r.error || "Failed") }));
                    }},
                    { icon: "🚀", label: "Redeploy", action: async () => {
                      if (!window.confirm(`Trigger a rollout restart on ${clusterName}?\n\nThis will restart the agent pod on the remote cluster.`)) return;
                      setActionResult({ title: "Redeploy", cluster: clusterName, loading: true });
                      const r = await clusterAction(`/api/agent/${encodeURIComponent(clusterName)}/redeploy`, "POST");
                      setActionResult(prev => ({ ...prev, loading: false, data: r.ok ? r.data : null, error: r.ok ? null : (r.data?.error || r.error || "Failed") }));
                      if (r.ok) refetchAgents();
                    }},
                    { icon: "✏️", label: "Edit Cluster", action: () => { setEditCluster({ name: clusterName, platform: agent.platform, apiUrl: agent.apiUrl || "" }); setConnectOpen(true); } },
                    { icon: "↻", label: "Reconnect", action: async () => {
                      setActionResult({ title: "Reconnect", cluster: clusterName, loading: true });
                      const r = await clusterAction(`/api/agent/${encodeURIComponent(clusterName)}/reconnect`, "POST");
                      setActionResult(prev => ({ ...prev, loading: false, data: r.ok ? r.data : null, error: r.ok ? null : (r.data?.error || r.error || "Failed") }));
                      if (r.ok) setTimeout(refetchAgents, 3000);
                    }},
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
                  {agent.outdated && (
                    <span className="cp-card-outdated-badge" title={`Running ${agent.mcpVersion || "unknown"} — hub is ${hubMcpVersion || "unknown"}`}>Update Available</span>
                  )}
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
                  <div className="cp-card-stat cp-health-stat" title={remoteHealthData.title} onClick={e => e.stopPropagation()}>
                    <div className="cp-card-stat-val" style={{ color: remoteHealthData.color }}>{remoteHealthData.score}%</div>
                    <div className="cp-card-stat-lbl">{remoteHealthData.label}</div>
                    <HealthTooltip breakdown={remoteHealthData.breakdown} />
                  </div>
                </div>
              </div>
            );
          })}

          {/* Add Cluster card */}
          <div className="cp-card-add" onClick={() => { setEditCluster(null); setConnectOpen(true); }}>
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
      {connectOpen && (
        <ModalErrorBoundary onClose={() => { setConnectOpen(false); setEditCluster(null); }}>
          <ConnectClusterModal open={connectOpen} onClose={() => { setConnectOpen(false); setEditCluster(null); }} onConnected={handleConnected} editCluster={editCluster} />
        </ModalErrorBoundary>
      )}

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
              <button className="cp-confirm-delete" onClick={async () => {
                const name = confirmDelete;
                setConfirmDelete(null);
                try {
                  const resp = await fetch(`/api/agent/${encodeURIComponent(name)}`, { method: "DELETE" });
                  const data = await resp.json().catch(() => ({}));
                  showToast(data.message || `Cluster "${name}" removed from fleet`, resp.ok ? "ok" : "err");
                } catch (err) {
                  showToast("Error removing cluster: " + err.message, "err");
                }
                refetchAgents();
              }}>Remove Cluster</button>
            </div>
          </div>
        </div>
      )}

      {/* Action Result Modal */}
      {actionResult && createPortal(
        <div className="ccm-overlay" onClick={() => setActionResult(null)}>
          <div className="ccm" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="ccm-header">
              <div className="ccm-header-left">
                <h2>{actionResult.title} — {actionResult.cluster}</h2>
              </div>
              <button className="ccm-close" onClick={() => setActionResult(null)}>x</button>
            </div>
            <div className="ccm-body" style={{ padding: 20 }}>
              {actionResult.loading && (
                <div style={{ textAlign: "center", padding: 30 }}>
                  <div style={{ fontSize: 28, marginBottom: 12, animation: "pulse 1.5s infinite" }}>...</div>
                  <div style={{ color: "var(--text2)", fontSize: 13 }}>Running {actionResult.title.toLowerCase()} on {actionResult.cluster}...</div>
                </div>
              )}
              {actionResult.error && (
                <div style={{ background: "color-mix(in srgb, var(--crit) 10%, transparent)", border: "1px solid var(--crit)", borderRadius: 8, padding: 14, marginBottom: 12 }}>
                  <div style={{ fontWeight: 600, color: "var(--crit)", marginBottom: 4 }}>Error</div>
                  <div style={{ fontSize: 13, color: "var(--text)" }}>{actionResult.error}</div>
                </div>
              )}
              {actionResult.data && !actionResult.loading && (
                <ActionResultContent title={actionResult.title} data={actionResult.data} />
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function ActionResultContent({ title, data }) {
  const kvRow = (label, value, color) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
      <span style={{ color: "var(--text2)", fontWeight: 500 }}>{label}</span>
      <span style={{ color: color || "var(--text)", fontWeight: 600 }}>{value ?? "—"}</span>
    </div>
  );

  // Status Check (remote) — /api/agent/{name}/status
  if (title === "Status Check" && (data.clusterName || data.summary)) {
    const s = data.summary || data;
    const statusColor = data.status === "live" ? "var(--ok)" : data.status === "stale" ? "var(--warn)" : "var(--crit)";
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {kvRow("Cluster", data.clusterName || data.cluster || "—")}
        {kvRow("Status", (data.status || "unknown").toUpperCase(), statusColor)}
        {kvRow("Platform", data.platform || s.platform || "—")}
        {kvRow("Version", s.version || data.version || "—")}
        {kvRow("Health", s.health || data.health || "—", s.health === "healthy" ? "var(--ok)" : s.health === "degraded" ? "var(--crit)" : "var(--warn)")}
        {kvRow("Nodes", s.nodes || "—")}
        {kvRow("Pods", s.pods ?? s.totalPods ?? "—")}
        {kvRow("Issues", s.issues ?? "0", (s.issues || 0) > 0 ? "var(--crit)" : "var(--ok)")}
        {kvRow("Warnings", s.warnings ?? "0", (s.warnings || 0) > 0 ? "var(--warn)" : "var(--ok)")}
        {data.agentVersion && kvRow("Agent Version", data.agentVersion)}
        {data.mcpVersion && kvRow("MCP Version", data.mcpVersion)}
        {kvRow("Bridge Connected", data.bridgeConnected ? "Yes" : "No", data.bridgeConnected ? "var(--ok)" : "var(--warn)")}
        {kvRow("Actions Enabled", data.actionsEnabled ? "Yes" : "No")}
        {data.lastReportTime && kvRow("Last Report", new Date(data.lastReportTime).toLocaleString())}
        {data.lastReportAgeSec != null && kvRow("Report Age", data.lastReportAgeSec < 60 ? `${data.lastReportAgeSec}s ago` : `${Math.round(data.lastReportAgeSec / 60)}m ago`)}
        {data.outdated && (
          <div style={{ marginTop: 8, padding: "8px 12px", borderRadius: 8, background: "color-mix(in srgb, var(--warn) 10%, transparent)", border: "1px solid var(--warn)", fontSize: 12, color: "var(--warn)" }}>
            Agent is outdated (running {data.mcpVersion}, hub is {data.hubVersion}). Consider redeploying.
          </div>
        )}
      </div>
    );
  }

  // Status Check (hub) — /api/cluster/summary
  if (title === "Status Check" && (data.isOpenShift !== undefined || data.cluster)) {
    const c = data.cluster || {};
    const n = data.nodes || {};
    const o = data.operators || {};
    const health = c.health || data.health || "unknown";
    const healthColor = health === "healthy" ? "var(--ok)" : health === "degraded" ? "var(--crit)" : "var(--warn)";
    const nsCount = typeof data.namespaces === "object" ? data.namespaces.total : data.namespaces;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {kvRow("Platform", data.isOpenShift ? "OpenShift" : "Kubernetes")}
        {kvRow("Version", c.version || c.kubernetesVersion || "—")}
        {kvRow("Health", health.toUpperCase(), healthColor)}
        {kvRow("Nodes", `${n.ready || 0} / ${n.total || 0} ready`)}
        {nsCount != null && kvRow("Namespaces", nsCount)}
        {o.total != null && kvRow("Operators", `${o.healthy || 0} / ${o.total || 0} healthy`)}
        {o.degraded != null && o.degraded > 0 && kvRow("Degraded Operators", o.degraded, "var(--crit)")}
        {data.pods != null && kvRow("Pods", typeof data.pods === "object" ? `${data.pods.running || 0} running / ${data.pods.total || 0} total` : data.pods)}
      </div>
    );
  }

  // Verify Health — /api/cluster/health-check or /api/agent/{name}/health-check
  if (title === "Verify Health") {
    const checks = data.checks || data.result || {};
    const isOk = data.ok !== false;
    const healthColor = data.health === "healthy" ? "var(--ok)" : data.health === "degraded" ? "var(--crit)" : data.health === "warning" ? "var(--warn)" : "var(--text2)";
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {kvRow("Result", isOk ? "HEALTHY" : "ISSUES FOUND", isOk ? "var(--ok)" : "var(--crit)")}
        {data.health && kvRow("Overall Health", data.health.toUpperCase(), healthColor)}
        {data.target && kvRow("Target", data.target)}
        {data.via && kvRow("Source", data.via === "direct-api" ? "Direct API" : data.via === "cached-report" ? "Cached Report" : data.via)}
        {checks.nodes && kvRow("Nodes", `${checks.nodes.ready || 0} / ${checks.nodes.total || 0} ready`, checks.nodes.ready === checks.nodes.total ? "var(--ok)" : "var(--warn)")}
        {checks.operators && kvRow("Operators", `${checks.operators.healthy || 0} / ${checks.operators.total || 0} healthy`, checks.operators.degraded > 0 ? "var(--crit)" : "var(--ok)")}
        {checks.operators?.degraded > 0 && (
          <div style={{ padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
            <span style={{ color: "var(--text2)" }}>Degraded: </span>
            {(checks.operators.degradedNames || []).map((n, i) => (
              <span key={i} style={{ display: "inline-block", background: "color-mix(in srgb, var(--crit) 12%, transparent)", color: "var(--crit)", padding: "1px 8px", borderRadius: 8, fontSize: 11, fontWeight: 600, marginRight: 4, marginBottom: 2 }}>
                {n}
              </span>
            ))}
          </div>
        )}
        {checks.pods && kvRow("Pods", typeof checks.pods === "object" ? `${checks.pods.running || checks.pods.total || 0} total` : checks.pods)}
        {checks.apiServer && kvRow("API Server", checks.apiServer.reachable ? "Reachable" : "Unreachable", checks.apiServer.reachable ? "var(--ok)" : "var(--crit)")}
        {checks.cachedAt && kvRow("Data From", new Date(checks.cachedAt).toLocaleString())}
        {data.proxiedTo && kvRow("Proxied To", data.proxiedTo)}
        {data.message && (
          <div style={{ marginTop: 6, padding: "8px 12px", borderRadius: 8, background: isOk ? "color-mix(in srgb, var(--ok) 8%, transparent)" : "color-mix(in srgb, var(--crit) 8%, transparent)", border: `1px solid ${isOk ? "var(--ok)" : "var(--crit)"}`, fontSize: 12, color: isOk ? "var(--ok)" : "var(--text)" }}>
            {data.message}
          </div>
        )}
      </div>
    );
  }

  // Redeploy / Reconnect / Sync RBAC — generic action result
  const isOk = data.ok !== false;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 0" }}>
        <span style={{ fontSize: 24 }}>{isOk ? "✅" : "❌"}</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, color: isOk ? "var(--ok)" : "var(--crit)" }}>
            {isOk ? "Success" : "Failed"}
          </div>
          <div style={{ fontSize: 13, color: "var(--text2)", marginTop: 2 }}>
            {data.message || (isOk ? `${title} completed successfully` : `${title} failed`)}
          </div>
        </div>
      </div>
      {data.target && kvRow("Target", data.target)}
      {data.via && kvRow("Via", data.via === "direct-api" ? "Direct API" : data.via)}
      {data.namespace && kvRow("Namespace", data.namespace)}
      {data.proxiedTo && kvRow("Proxied To", data.proxiedTo)}
      {data.guidance && (
        <div style={{ marginTop: 8, padding: "10px 12px", borderRadius: 8, background: "var(--bg2)", border: "1px solid var(--border)", fontSize: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--text)" }}>Troubleshooting Steps:</div>
          {data.guidance.map((g, i) => (
            <div key={i} style={{ color: "var(--text2)", marginBottom: 3, fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: 11 }}>{g}</div>
          ))}
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
      const res = await fetch("/api/fleet/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      setResponse(data.reply || data.error || "No response from fleet.");
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
              <div
                className="cp-fleet-response md-content"
                style={{ display: "block", marginTop: 12 }}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(response) }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
