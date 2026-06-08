#!/usr/bin/env bash
# ============================================================================
# TCS Agentic AI — Secondary Cluster Agent Deployment
# ============================================================================
#
# Deploys the lightweight AI-native agent to a secondary (spoke) cluster.
# The agent registers with the hub, sends periodic health/scan reports, and
# participates in AI reasoning via the bidirectional SSE bridge.
#
# Prerequisites:
#   - oc/kubectl logged in to the SECONDARY cluster (not the hub)
#   - Hub must be deployed and reachable from this cluster
#   - podman/docker available if building a custom image (optional)
#
# Usage:
#   ./deploy-agent.sh --hub-url https://hub.example.com --cluster-name prod-east --platform openshift
#   ./deploy-agent.sh --hub-url https://hub.example.com --cluster-name staging-gke --platform gke
#   ./deploy-agent.sh --hub-url https://hub.example.com --cluster-name dev-eks --platform eks --actions
#   ./deploy-agent.sh --status                     # Check agent status
#   ./deploy-agent.sh --rollback                   # Rollback agent
#   ./deploy-agent.sh --uninstall                  # Remove agent from cluster
#
# Options:
#   --hub-url URL          Hub server URL (required for deploy)
#   --cluster-name NAME    Name for this cluster (required for deploy)
#   --platform PLATFORM    openshift | rancher | eks | aks | gke | k8s (default: k8s)
#   --actions              Enable remote remediation actions (cordon, drain, restart, scale)
#   --tls-skip             Skip TLS verification for hub connection (self-signed certs)
#   -n, --namespace NS     Agent namespace (default: tcs-agentic-system, or openshift-tcs-agentic for OpenShift)
#   --image IMAGE          Override agent image
#   --scan-interval SEC    Cluster scan interval in seconds (default: 60)
#   --status               Show agent deployment status
#   --rollback             Rollback agent to previous revision
#   --uninstall            Remove agent from this cluster
#
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
HUB_URL=""
CLUSTER_NAME=""
PLATFORM="k8s"
NS=""
ACTIONS=false
TLS_SKIP=false
SCAN_INTERVAL=60
IMAGE="${AGENT_IMAGE:-quay.io/karuppucs/tcs-agentic-ai:latest}"
ACTION="deploy"
BUILD=false

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Detect CLI
if command -v oc &>/dev/null; then
  CLI="oc"
elif command -v kubectl &>/dev/null; then
  CLI="kubectl"
else
  echo "ERROR: Neither 'oc' nor 'kubectl' found."
  exit 1
fi

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub-url)        HUB_URL="$2"; shift 2 ;;
    --cluster-name)   CLUSTER_NAME="$2"; shift 2 ;;
    --platform)       PLATFORM="$2"; shift 2 ;;
    --actions)        ACTIONS=true; shift ;;
    --tls-skip)       TLS_SKIP=true; shift ;;
    --scan-interval)  SCAN_INTERVAL="$2"; shift 2 ;;
    --image)          IMAGE="$2"; shift 2 ;;
    -n|--namespace)   NS="$2"; shift 2 ;;
    --build)          BUILD=true; shift ;;
    --status)         ACTION="status"; shift ;;
    --rollback)       ACTION="rollback"; shift ;;
    --uninstall)      ACTION="uninstall"; shift ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Set default namespace based on platform
if [ -z "$NS" ]; then
  if [ "$PLATFORM" = "openshift" ]; then
    NS="openshift-tcs-agentic"
  else
    NS="tcs-agentic-system"
  fi
fi

DEPLOY_NAME="tcs-agentic-agent"

# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------
if [ "$ACTION" = "status" ]; then
  echo "============================================"
  echo " TCS Agentic AI — Agent Status"
  echo " Namespace: $NS"
  echo "============================================"
  echo ""
  echo "--- Pods ---"
  $CLI get pods -n "$NS" -l app.kubernetes.io/name=tcs-agentic-agent -o wide 2>/dev/null || echo "  No agent pods found"
  echo ""
  echo "--- Deployment ---"
  $CLI get deploy "$DEPLOY_NAME" -n "$NS" -o wide 2>/dev/null || echo "  No agent deployment found"
  echo ""
  echo "--- Agent Logs (last 20 lines) ---"
  POD=$($CLI get pods -n "$NS" -l app.kubernetes.io/name=tcs-agentic-agent -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [ -n "$POD" ]; then
    $CLI logs "$POD" -n "$NS" --tail=20 2>/dev/null || echo "  Cannot fetch logs"
    echo ""
    echo "--- Agent Health ---"
    $CLI exec "$POD" -n "$NS" -- wget -qO- http://localhost:8080/status 2>/dev/null | head -c 500 || echo "  Cannot reach agent health endpoint"
  else
    echo "  No running agent pod found"
  fi
  echo ""
  exit 0
fi

# ---------------------------------------------------------------------------
# Rollback
# ---------------------------------------------------------------------------
if [ "$ACTION" = "rollback" ]; then
  echo "Rolling back agent deployment..."
  $CLI rollout undo deployment/"$DEPLOY_NAME" -n "$NS"
  $CLI rollout status deployment/"$DEPLOY_NAME" -n "$NS" --timeout=120s
  echo "Rollback complete."
  exit 0
fi

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
if [ "$ACTION" = "uninstall" ]; then
  echo "============================================"
  echo " Removing TCS Agentic AI Agent"
  echo " Namespace: $NS"
  echo "============================================"
  echo ""
  read -p "Are you sure you want to remove the agent? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Cancelled."
    exit 0
  fi
  $CLI delete deployment "$DEPLOY_NAME" -n "$NS" --ignore-not-found
  $CLI delete service "$DEPLOY_NAME" -n "$NS" --ignore-not-found
  $CLI delete configmap "${DEPLOY_NAME}-config" -n "$NS" --ignore-not-found
  $CLI delete serviceaccount "$DEPLOY_NAME" -n "$NS" --ignore-not-found
  $CLI delete clusterrolebinding "${DEPLOY_NAME}-reader-binding" --ignore-not-found
  $CLI delete clusterrole "${DEPLOY_NAME}-reader" --ignore-not-found
  $CLI delete namespace "$NS" --ignore-not-found
  echo ""
  echo "Agent removed. The hub will mark this cluster as unreachable after ~5 minutes."
  echo "To fully remove from hub, use the 'Remove Cluster' action in the dashboard."
  exit 0
fi

# ---------------------------------------------------------------------------
# Validate required params
# ---------------------------------------------------------------------------
if [ -z "$HUB_URL" ]; then
  echo "ERROR: --hub-url is required."
  echo "Usage: ./deploy-agent.sh --hub-url https://hub.example.com --cluster-name my-cluster --platform openshift"
  exit 1
fi
if [ -z "$CLUSTER_NAME" ]; then
  echo "ERROR: --cluster-name is required."
  echo "Usage: ./deploy-agent.sh --hub-url https://hub.example.com --cluster-name my-cluster --platform openshift"
  exit 1
fi

# ---------------------------------------------------------------------------
# Build agent image (optional)
# ---------------------------------------------------------------------------
if $BUILD; then
  AGENT_DIR="$REPO_ROOT/agent"
  if command -v podman &>/dev/null; then
    RUNTIME="podman"
  elif command -v docker &>/dev/null; then
    RUNTIME="docker"
  else
    echo "ERROR: No container runtime found for --build."
    exit 1
  fi
  echo "[build] Building agent image..."
  $RUNTIME build -t "$IMAGE" -f "$AGENT_DIR/Dockerfile" "$AGENT_DIR"
  echo "[build] Pushing $IMAGE..."
  $RUNTIME push "$IMAGE"
fi

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------
echo "============================================"
echo " TCS Agentic AI — Agent Deployment"
echo "============================================"
echo " Cluster   : $CLUSTER_NAME"
echo " Platform  : $PLATFORM"
echo " Hub URL   : $HUB_URL"
echo " Namespace : $NS"
echo " Image     : $IMAGE"
echo " Actions   : $ACTIONS"
echo " TLS skip  : $TLS_SKIP"
echo " Scan int. : ${SCAN_INTERVAL}s"
echo "============================================"
echo ""

# 1. Namespace
echo "[1/5] Creating namespace..."
cat <<EOF | $CLI apply -f -
apiVersion: v1
kind: Namespace
metadata:
  name: $NS
  labels:
    app.kubernetes.io/name: tcs-agentic-agent
    app.kubernetes.io/part-of: mcp-ai-assistant
EOF

# 2. ServiceAccount + ClusterRole + Binding
echo "[2/5] Creating service account and RBAC..."
cat <<EOF | $CLI apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: $DEPLOY_NAME
  namespace: $NS
  labels:
    app.kubernetes.io/name: tcs-agentic-agent
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${DEPLOY_NAME}-reader
rules:
  - apiGroups: [""]
    resources: [nodes, pods, pods/log, services, namespaces, events, resourcequotas,
                limitranges, configmaps, secrets, serviceaccounts, persistentvolumeclaims,
                persistentvolumes, endpoints, replicationcontrollers]
    verbs: [get, list, watch]
  - apiGroups: [apps]
    resources: [deployments, replicasets, statefulsets, daemonsets]
    verbs: [get, list, watch]
  - apiGroups: [batch]
    resources: [jobs, cronjobs]
    verbs: [get, list, watch]
  - apiGroups: [autoscaling]
    resources: [horizontalpodautoscalers]
    verbs: [get, list, watch]
  - apiGroups: [rbac.authorization.k8s.io]
    resources: [roles, rolebindings, clusterroles, clusterrolebindings]
    verbs: [get, list]
  - apiGroups: [networking.k8s.io]
    resources: [networkpolicies, ingresses, ingressclasses]
    verbs: [get, list]
  - apiGroups: [policy]
    resources: [poddisruptionbudgets]
    verbs: [get, list]
  - apiGroups: [storage.k8s.io]
    resources: [storageclasses, csidrivers]
    verbs: [get, list]
  - apiGroups: [metrics.k8s.io]
    resources: [nodes, pods]
    verbs: [get, list]
  - apiGroups: [apiextensions.k8s.io]
    resources: [customresourcedefinitions]
    verbs: [get, list]
$(if [ "$PLATFORM" = "openshift" ]; then cat <<OSEOF
  - apiGroups: [config.openshift.io]
    resources: [clusterversions, clusteroperators, infrastructures]
    verbs: [get, list]
  - apiGroups: [route.openshift.io]
    resources: [routes]
    verbs: [get, list]
  - apiGroups: [apps.openshift.io]
    resources: [deploymentconfigs]
    verbs: [get, list]
  - apiGroups: [project.openshift.io]
    resources: [projects]
    verbs: [get, list]
  - apiGroups: [image.openshift.io]
    resources: [imagestreams]
    verbs: [get, list]
  - apiGroups: [security.openshift.io]
    resources: [securitycontextconstraints]
    verbs: [get, list]
  - apiGroups: [operators.coreos.com]
    resources: [subscriptions, clusterserviceversions, installplans]
    verbs: [get, list]
  - apiGroups: [machine.openshift.io]
    resources: [machines, machinesets]
    verbs: [get, list]
  - apiGroups: [monitoring.coreos.com]
    resources: [prometheuses, alertmanagers, servicemonitors, prometheusrules]
    verbs: [get, list]
  - apiGroups: [compliance.openshift.io]
    resources: [compliancesuites, compliancescans, profiles, compliancecheckresults]
    verbs: [get, list]
OSEOF
fi)
$(if [ "$ACTIONS" = "true" ]; then cat <<ACTEOF
  - apiGroups: [""]
    resources: [pods]
    verbs: [delete]
  - apiGroups: [""]
    resources: [nodes]
    verbs: [patch, update]
  - apiGroups: [""]
    resources: [pods/eviction]
    verbs: [create]
  - apiGroups: [apps]
    resources: [deployments, deployments/scale, statefulsets/scale]
    verbs: [patch, update]
ACTEOF
fi)
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${DEPLOY_NAME}-reader-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ${DEPLOY_NAME}-reader
subjects:
  - kind: ServiceAccount
    name: $DEPLOY_NAME
    namespace: $NS
EOF

# 3. ConfigMap
echo "[3/5] Creating ConfigMap..."
cat <<EOF | $CLI apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${DEPLOY_NAME}-config
  namespace: $NS
data:
  HUB_SERVER_URL: "$HUB_URL"
  CLUSTER_NAME: "$CLUSTER_NAME"
  CLUSTER_PLATFORM: "$PLATFORM"
  SCAN_INTERVAL: "$SCAN_INTERVAL"
  HUB_TLS_SKIP_VERIFY: "$TLS_SKIP"
  ALLOW_REMOTE_ACTIONS: "$ACTIONS"
  LOG_LEVEL: "info"
EOF

# 4. Deployment + Service
echo "[4/5] Deploying agent..."
cat <<EOF | $CLI apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $DEPLOY_NAME
  namespace: $NS
  labels:
    app.kubernetes.io/name: tcs-agentic-agent
    app.kubernetes.io/component: agent
    app.kubernetes.io/part-of: mcp-ai-assistant
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: tcs-agentic-agent
  template:
    metadata:
      labels:
        app.kubernetes.io/name: tcs-agentic-agent
        tcs.com/cluster-name: "$CLUSTER_NAME"
    spec:
      serviceAccountName: $DEPLOY_NAME
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: agent
          image: $IMAGE
          imagePullPolicy: Always
          ports:
            - containerPort: 8080
              name: health
          envFrom:
            - configMapRef:
                name: ${DEPLOY_NAME}-config
          env:
            - name: NODE_EXTRA_CA_CERTS
              value: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              cpu: 200m
              memory: 256Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 15
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 30
---
apiVersion: v1
kind: Service
metadata:
  name: $DEPLOY_NAME
  namespace: $NS
  labels:
    app.kubernetes.io/name: tcs-agentic-agent
spec:
  selector:
    app.kubernetes.io/name: tcs-agentic-agent
  ports:
    - port: 8080
      targetPort: 8080
      name: health
EOF

# 5. Wait for rollout
echo "[5/5] Waiting for agent to start..."
$CLI rollout status deployment/"$DEPLOY_NAME" -n "$NS" --timeout=120s

echo ""
echo "--- Agent Pod ---"
$CLI get pods -n "$NS" -l app.kubernetes.io/name=tcs-agentic-agent -o wide
echo ""

# Verify registration with hub
echo "--- Verifying hub registration ---"
sleep 5
RESP=$(curl -sk "${HUB_URL}/api/agent/status" 2>/dev/null || echo "")
if echo "$RESP" | grep -q "$CLUSTER_NAME"; then
  echo "  Agent '$CLUSTER_NAME' registered with hub successfully!"
else
  echo "  Agent deployed but hub registration pending."
  echo "  Check agent logs:  $CLI logs -n $NS -l app.kubernetes.io/name=tcs-agentic-agent --tail=30"
  echo "  Common issues:"
  echo "    - Hub unreachable: verify network/firewall between clusters"
  echo "    - TLS errors: add --tls-skip flag"
  echo "    - DNS failure: verify hub hostname resolves from this cluster"
fi

echo ""
echo "============================================"
echo " Agent deployment complete!"
echo "============================================"
echo ""
echo " Cluster       : $CLUSTER_NAME"
echo " Platform      : $PLATFORM"
echo " Hub           : $HUB_URL"
echo " Namespace     : $NS"
echo " Actions       : $ACTIONS"
echo ""
echo " The agent will now appear in the hub dashboard"
echo " under 'Select a Cluster' workspace."
echo ""
echo " Management commands:"
echo "   ./deploy-agent.sh --status               # Check agent status"
echo "   ./deploy-agent.sh --rollback              # Rollback agent"
echo "   ./deploy-agent.sh --uninstall             # Remove agent"
echo "   $CLI logs -n $NS -l app.kubernetes.io/name=tcs-agentic-agent -f  # Tail logs"
echo "============================================"
