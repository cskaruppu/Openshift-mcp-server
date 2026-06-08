#!/usr/bin/env bash
# ============================================================================
# TCS Agentic AI — Spoke Cluster Deployment (Full MCP Server)
# ============================================================================
#
# Deploys the SAME MCP server image to a secondary cluster in spoke mode.
# The spoke runs the full query logic locally (identical to hub), registers
# with the hub, and the hub proxies API calls to it — ensuring identical
# results across all clusters.
#
# This follows the ACM/Rancher/ArgoCD pattern:
#   - Same image on every cluster (no lightweight agent)
#   - Local execution, central aggregation
#   - Hub proxies on demand — no stale cached data
#
# Prerequisites:
#   - oc/kubectl logged in to the SECONDARY cluster
#   - Hub deployed and reachable from this cluster
#
# Usage:
#   ./deploy/spoke/deploy.sh --hub-url https://hub.example.com --cluster-name prod-east --platform openshift
#   ./deploy/spoke/deploy.sh --hub-url https://hub.example.com --cluster-name staging-gke --platform gke
#   ./deploy/spoke/deploy.sh --status                     # Check spoke status
#   ./deploy/spoke/deploy.sh --rollback                   # Rollback spoke
#   ./deploy/spoke/deploy.sh --uninstall                  # Remove spoke from cluster
#
# Options:
#   --hub-url URL          Hub server URL (required for deploy)
#   --cluster-name NAME    Name for this cluster (required for deploy)
#   --platform PLATFORM    openshift | rancher | eks | aks | gke | k8s (default: k8s)
#   --tls-skip             Skip TLS verification for hub connection
#   -n, --namespace NS     Namespace (default: openshift-mcp for OpenShift, tcs-agentic-system otherwise)
#   --image IMAGE          Override image (default: same as hub image)
#   --with-db              Deploy PostgreSQL for persistent chat/audit on spoke
#   --status               Show spoke deployment status
#   --rollback             Rollback to previous revision
#   --uninstall            Remove spoke from this cluster
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
TLS_SKIP=false
IMAGE="${IMAGE:-quay.io/karuppucs/openshift-mcp-server:latest}"
ACTION="deploy"
WITH_DB=false

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

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
    --tls-skip)       TLS_SKIP=true; shift ;;
    --image)          IMAGE="$2"; shift 2 ;;
    -n|--namespace)   NS="$2"; shift 2 ;;
    --with-db)        WITH_DB=true; shift ;;
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
    NS="openshift-mcp"
  else
    NS="tcs-agentic-system"
  fi
fi

DEPLOY_NAME="mcp-server"

# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------
if [ "$ACTION" = "status" ]; then
  echo "============================================"
  echo " TCS Agentic AI — Spoke Status"
  echo " Namespace: $NS"
  echo "============================================"
  echo ""
  echo "--- Pods ---"
  $CLI get pods -n "$NS" -o wide 2>/dev/null || echo "  No pods found"
  echo ""
  echo "--- Deployment ---"
  $CLI get deploy -n "$NS" -o wide 2>/dev/null || echo "  No deployments found"
  echo ""
  echo "--- Services ---"
  $CLI get svc -n "$NS" 2>/dev/null || echo "  No services found"
  echo ""
  # Health check
  POD=$($CLI get pods -n "$NS" -l app.kubernetes.io/name=openshift-mcp-server -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [ -n "$POD" ]; then
    echo "--- Spoke Health ---"
    $CLI exec "$POD" -n "$NS" -- wget -qO- http://localhost:3000/healthz 2>/dev/null || echo "  Cannot reach health endpoint"
    echo ""
    echo "--- Spoke Logs (last 20 lines) ---"
    $CLI logs "$POD" -n "$NS" --tail=20 2>/dev/null || echo "  Cannot fetch logs"
  fi
  echo ""
  exit 0
fi

# ---------------------------------------------------------------------------
# Rollback
# ---------------------------------------------------------------------------
if [ "$ACTION" = "rollback" ]; then
  echo "Rolling back spoke deployment..."
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
  echo " Removing TCS Agentic AI Spoke"
  echo " Namespace: $NS"
  echo "============================================"
  echo ""
  read -p "Are you sure? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Cancelled."
    exit 0
  fi
  $CLI delete deployment "$DEPLOY_NAME" -n "$NS" --ignore-not-found
  $CLI delete service "$DEPLOY_NAME" -n "$NS" --ignore-not-found
  $CLI delete configmap mcp-server-config -n "$NS" --ignore-not-found
  $CLI delete secret mcp-server-secrets -n "$NS" --ignore-not-found
  $CLI delete serviceaccount mcp-server -n "$NS" --ignore-not-found
  $CLI delete clusterrolebinding mcp-server-reader-binding --ignore-not-found
  $CLI delete clusterrole mcp-server-reader --ignore-not-found
  if [ "$PLATFORM" = "openshift" ]; then
    $CLI delete route "$DEPLOY_NAME" -n "$NS" --ignore-not-found
  fi
  echo ""
  echo "Spoke removed. The hub will mark this cluster as unreachable."
  echo "Remove from hub dashboard via 'Remove Cluster' in the cluster picker."
  exit 0
fi

# ---------------------------------------------------------------------------
# Validate
# ---------------------------------------------------------------------------
if [ -z "$HUB_URL" ]; then
  echo "ERROR: --hub-url is required."
  echo "Usage: ./deploy/spoke/deploy.sh --hub-url https://hub.example.com --cluster-name my-cluster --platform openshift"
  exit 1
fi
if [ -z "$CLUSTER_NAME" ]; then
  echo "ERROR: --cluster-name is required."
  echo "Usage: ./deploy/spoke/deploy.sh --hub-url https://hub.example.com --cluster-name my-cluster --platform openshift"
  exit 1
fi

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------
STEPS=6
STEP=0
next() { STEP=$((STEP + 1)); echo ""; echo "[$STEP/$STEPS] $1"; }

echo "============================================"
echo " TCS Agentic AI — Spoke Deployment"
echo "============================================"
echo " Cluster   : $CLUSTER_NAME"
echo " Platform  : $PLATFORM"
echo " Hub URL   : $HUB_URL"
echo " Namespace : $NS"
echo " Image     : $IMAGE (same as hub)"
echo " TLS skip  : $TLS_SKIP"
echo " With DB   : $WITH_DB"
echo " Mode      : spoke (full MCP server)"
echo "============================================"
echo ""

# Detect spoke external URL (for hub registration)
SPOKE_URL=""

# 1. Namespace
next "Creating namespace..."
cat <<EOF | $CLI apply -f -
apiVersion: v1
kind: Namespace
metadata:
  name: $NS
  labels:
    app.kubernetes.io/name: openshift-mcp-server
    app.kubernetes.io/part-of: mcp-ai-assistant
EOF

# 2. ServiceAccount + RBAC (same as hub — full cluster-reader)
next "Creating service account and RBAC..."
cat <<EOF | $CLI apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: mcp-server
  namespace: $NS
  labels:
    app.kubernetes.io/name: openshift-mcp-server
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: mcp-server-reader
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
  - apiGroups: [apiregistration.k8s.io]
    resources: [apiservices]
    verbs: [get, list]
$(if [ "$PLATFORM" = "openshift" ]; then cat <<OSEOF
  - apiGroups: [config.openshift.io]
    resources: [clusterversions, clusteroperators, infrastructures, oauths, ingresses, networks, proxies, schedulers, apiservers]
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
    resources: [imagestreams, imagestreamtags]
    verbs: [get, list, watch]
  - apiGroups: [build.openshift.io]
    resources: [builds, buildconfigs]
    verbs: [get, list, watch]
  - apiGroups: [security.openshift.io]
    resources: [securitycontextconstraints]
    verbs: [get, list]
  - apiGroups: [operators.coreos.com]
    resources: [subscriptions, clusterserviceversions, installplans, operatorgroups, catalogsources]
    verbs: [get, list, watch]
  - apiGroups: [packages.operators.coreos.com]
    resources: [packagemanifests]
    verbs: [get, list]
  - apiGroups: [machine.openshift.io]
    resources: [machines, machinesets, machinehealthchecks]
    verbs: [get, list]
  - apiGroups: [machineconfiguration.openshift.io]
    resources: [machineconfigs, machineconfigpools]
    verbs: [get, list]
  - apiGroups: [monitoring.coreos.com]
    resources: [prometheuses, alertmanagers, servicemonitors, prometheusrules, podmonitors]
    verbs: [get, list]
  - apiGroups: [compliance.openshift.io]
    resources: [compliancesuites, compliancescans, profiles, profilebundles, compliancecheckresults]
    verbs: [get, list]
  - apiGroups: [user.openshift.io]
    resources: [users, groups, identities]
    verbs: [get, list]
  - apiGroups: [quota.openshift.io]
    resources: [clusterresourcequotas]
    verbs: [get, list]
  - apiGroups: [argoproj.io]
    resources: [applications, appprojects, applicationsets]
    verbs: [get, list, watch]
  - apiGroups: [velero.io]
    resources: [backups, schedules, restores, backupstoragelocations]
    verbs: [get, list]
  - apiGroups: [tekton.dev]
    resources: [pipelines, pipelineruns, tasks, taskruns]
    verbs: [get, list, watch]
  - apiGroups: [authorization.k8s.io]
    resources: [subjectaccessreviews]
    verbs: [create]
OSEOF
fi)
  # Remediation — same as hub
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
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: mcp-server-reader-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: mcp-server-reader
subjects:
  - kind: ServiceAccount
    name: mcp-server
    namespace: $NS
EOF

# 3. ConfigMap + Secrets
next "Creating ConfigMap and Secrets..."
cat <<EOF | $CLI apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: mcp-server-config
  namespace: $NS
data:
  MCP_MODE: "spoke"
  MCP_TRANSPORT: "sse"
  MCP_SERVER_PORT: "3000"
  LOG_LEVEL: "info"
  HUB_URL: "$HUB_URL"
  CLUSTER_NAME: "$CLUSTER_NAME"
  CLUSTER_PLATFORM: "$PLATFORM"
  HUB_TLS_SKIP_VERIFY: "$TLS_SKIP"
  AUTH_MODE: "none"
  EMERGENCY_AUTO_FIX: "false"
  ALLOW_PRIVATE_CLUSTER_IPS: "true"
---
apiVersion: v1
kind: Secret
metadata:
  name: mcp-server-secrets
  namespace: $NS
type: Opaque
stringData:
  MCP_API_TOKEN: ""
EOF

# 4. Deployment + Service (+ Route for OpenShift)
next "Deploying MCP server (spoke mode)..."
cat <<EOF | $CLI apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $DEPLOY_NAME
  namespace: $NS
  labels:
    app.kubernetes.io/name: openshift-mcp-server
    app.kubernetes.io/component: spoke
    app.kubernetes.io/part-of: mcp-ai-assistant
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: openshift-mcp-server
  template:
    metadata:
      labels:
        app.kubernetes.io/name: openshift-mcp-server
        tcs.com/mcp-mode: spoke
        tcs.com/cluster-name: "$CLUSTER_NAME"
    spec:
      serviceAccountName: mcp-server
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: mcp-server
          image: $IMAGE
          imagePullPolicy: Always
          ports:
            - containerPort: 3000
              name: http
          envFrom:
            - configMapRef:
                name: mcp-server-config
            - secretRef:
                name: mcp-server-secrets
          env:
            - name: NODE_EXTRA_CA_CERTS
              value: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
            - name: NODE_OPTIONS
              value: "--max-old-space-size=768"
          resources:
            requests:
              cpu: 100m
              memory: 512Mi
            limits:
              cpu: 500m
              memory: 1Gi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: tmp
              mountPath: /tmp
            - name: data
              mountPath: /data
          readinessProbe:
            httpGet:
              path: /readyz
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 30
      volumes:
        - name: tmp
          emptyDir: {}
        - name: data
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: $DEPLOY_NAME
  namespace: $NS
  labels:
    app.kubernetes.io/name: openshift-mcp-server
spec:
  selector:
    app.kubernetes.io/name: openshift-mcp-server
  ports:
    - port: 3000
      targetPort: 3000
      name: http
EOF

# Create Route (OpenShift) or print port-forward instructions
if [ "$PLATFORM" = "openshift" ] && [ "$CLI" = "oc" ]; then
  cat <<EOF | $CLI apply -f -
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: $DEPLOY_NAME
  namespace: $NS
  labels:
    app.kubernetes.io/name: openshift-mcp-server
  annotations:
    haproxy.router.openshift.io/timeout: 600s
    haproxy.router.openshift.io/timeout-tunnel: 600s
spec:
  to:
    kind: Service
    name: $DEPLOY_NAME
  port:
    targetPort: http
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect
EOF
fi

# 5. Wait for rollout + detect spoke URL
next "Waiting for spoke to start..."
$CLI rollout status deployment/"$DEPLOY_NAME" -n "$NS" --timeout=180s

echo ""
echo "--- Pod Status ---"
$CLI get pods -n "$NS" -o wide
echo ""

# Detect external URL
if [ "$CLI" = "oc" ]; then
  SPOKE_URL=$(oc get route "$DEPLOY_NAME" -n "$NS" -o jsonpath='https://{.spec.host}' 2>/dev/null || echo "")
fi
if [ -z "$SPOKE_URL" ]; then
  SPOKE_URL="http://${DEPLOY_NAME}.${NS}.svc.cluster.local:3000"
fi

# 6. Update ConfigMap with spoke external URL and restart
next "Configuring spoke external URL and restarting..."
$CLI patch configmap mcp-server-config -n "$NS" --type merge -p "{\"data\":{\"SPOKE_EXTERNAL_URL\":\"$SPOKE_URL\"}}"
$CLI rollout restart deployment/"$DEPLOY_NAME" -n "$NS"
$CLI rollout status deployment/"$DEPLOY_NAME" -n "$NS" --timeout=120s

# Verify registration
echo ""
echo "--- Verifying hub registration ---"
sleep 8
RESP=$(curl -sk "${HUB_URL}/api/spoke/status" 2>/dev/null || echo "")
if echo "$RESP" | grep -q "$CLUSTER_NAME"; then
  echo "  Spoke '$CLUSTER_NAME' registered with hub successfully!"
else
  echo "  Spoke deployed but hub registration may be pending."
  echo "  Check spoke logs: $CLI logs -n $NS -l app.kubernetes.io/name=openshift-mcp-server --tail=30"
  echo ""
  echo "  Common issues:"
  echo "    - Hub unreachable from this cluster (network/firewall)"
  echo "    - TLS errors: add --tls-skip flag"
  echo "    - DNS: verify hub hostname resolves from spoke cluster"
fi

echo ""
echo "============================================"
echo " Spoke deployment complete!"
echo "============================================"
echo ""
echo " Cluster       : $CLUSTER_NAME"
echo " Platform      : $PLATFORM"
echo " Hub           : $HUB_URL"
echo " Spoke URL     : $SPOKE_URL"
echo " Namespace     : $NS"
echo " Image         : $IMAGE (same as hub)"
echo " Mode          : spoke (full MCP server)"
echo ""
echo " This spoke runs the SAME code as the hub."
echo " When users query this cluster from the hub dashboard,"
echo " the hub proxies to this spoke — identical results guaranteed."
echo ""
echo " The cluster now appears in the hub's 'Select a Cluster' workspace."
echo ""
echo " Management:"
echo "   ./deploy/spoke/deploy.sh --status               # Check spoke status"
echo "   ./deploy/spoke/deploy.sh --rollback              # Rollback spoke"
echo "   ./deploy/spoke/deploy.sh --uninstall             # Remove spoke"
echo "   $CLI logs -n $NS -l app.kubernetes.io/name=openshift-mcp-server -f"
echo "============================================"
