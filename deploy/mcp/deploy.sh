#!/usr/bin/env bash
# ============================================================================
# TCS Agentic AI — MCP SERVER deployment (run on EVERY cluster, incl. hub)
# ============================================================================
#
# Deploys the stateless MCP server pod on the CURRENT oc/kubectl context and
# registers it with the management bundle (dashboard). One identical pod per
# cluster — OpenShift, Rancher, EKS, AKS, GKE, or vanilla K8s.
#
#   Management Bundle (dashboard + PostgreSQL + Redis, deployed once)
#          ▲ register + heartbeat (30s, carries build version)
#          │ live proxy for widgets/chat — no caching, no local state
#   ┌──────┴───────┐
#   │  MCP Server  │  MCP_MODE=spoke — stateless, no DB, no PVC
#   └──────────────┘
#
# Run this on the management cluster TOO, with --cluster-name hub-cluster —
# that name tells the control plane "this is my own cluster's data plane"
# (the ACM local-cluster pattern), so it won't show up as a duplicate card.
#
# This script NEVER touches the management bundle — refresh MCP servers as
# often as you like; dashboard/PostgreSQL/Redis data stays intact on PVCs.
#
# Prerequisites:
#   - oc/kubectl logged in to the target cluster
#   - Management bundle deployed and reachable from this cluster
#
# Usage:
#   ./deploy/mcp/deploy.sh --hub-url https://<dashboard-route> --cluster-name prod-east --platform openshift
#   ./deploy/mcp/deploy.sh --hub-url https://<dashboard-route> --cluster-name hub-cluster --platform openshift   # on the management cluster
#   ./deploy/mcp/deploy.sh --status                     # Check MCP server status
#   ./deploy/mcp/deploy.sh --rollback                   # Rollback MCP server
#   ./deploy/mcp/deploy.sh --uninstall                  # Remove from this cluster
#
# Options:
#   --hub-url URL          Management bundle URL (required for deploy)
#   --cluster-name NAME    Name for this cluster (required; use "hub-cluster" on the management cluster)
#   --platform PLATFORM    openshift | rancher | eks | aks | gke | k8s (default: k8s)
#   --spoke-url URL        Override URL that the control plane will use to reach this cluster
#                          (use when the hub can't resolve this cluster's Route hostname)
#   --tls-skip             Skip TLS verification for hub connection
#   -n, --namespace NS     Namespace (default: openshift-mcp for OpenShift, tcs-agentic-system otherwise)
#   --image IMAGE          Override image (default: same image as control plane)
#   --hub-token TOKEN      Hub API token (MCP_API_TOKEN from hub) for registration auth
#   --hub-context CTX      Auto-fetch hub token from hub cluster K8s secret (kubectl context name)
#   --hub-namespace NS     Hub namespace when using --hub-context (default: openshift-mcp)
#   --status               Show MCP server deployment status
#   --rollback             Rollback to previous revision
#   --uninstall            Remove MCP server from this cluster
#
# After the MCP image is updated in the registry, you do NOT need to rerun
# this script — use the cluster card's ⋮ → Redeploy button in the dashboard
# (clusters running an older build show an "Update Available" badge).
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
HUB_URL=""
HUB_TOKEN=""
HUB_CONTEXT=""
HUB_NS="openshift-mcp"
CLUSTER_NAME=""
PLATFORM="k8s"
NS=""
TLS_SKIP=false
SPOKE_URL_OVERRIDE=""
IMAGE="${IMAGE:-quay.io/karuppucs/openshift-mcp-server:latest}"
ACTION="deploy"

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
    --hub-token)      HUB_TOKEN="$2"; shift 2 ;;
    --hub-context)    HUB_CONTEXT="$2"; shift 2 ;;
    --hub-namespace)  HUB_NS="$2"; shift 2 ;;
    --cluster-name)   CLUSTER_NAME="$2"; shift 2 ;;
    --platform)       PLATFORM="$2"; shift 2 ;;
    --spoke-url)      SPOKE_URL_OVERRIDE="$2"; shift 2 ;;
    --tls-skip)       TLS_SKIP=true; shift ;;
    --image)          IMAGE="$2"; shift 2 ;;
    -n|--namespace)   NS="$2"; shift 2 ;;
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

# Role-based naming: agentic-ai-agent is the per-cluster worker, distinct from
# agentic-ai-control-plane so both coexist on the hub cluster.
DEPLOY_NAME="agentic-ai-agent"

# ---------------------------------------------------------------------------
# Auto-fetch hub token from hub cluster's K8s secret (if --hub-context given)
# ---------------------------------------------------------------------------
if [ -n "$HUB_CONTEXT" ] && [ -z "$HUB_TOKEN" ]; then
  echo "Fetching hub token from context '$HUB_CONTEXT' (namespace: $HUB_NS)..."
  HUB_TOKEN=$(kubectl --context="$HUB_CONTEXT" get secret agentic-ai-server-secrets \
    -n "$HUB_NS" -o jsonpath='{.data.MCP_API_TOKEN}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  if [ -n "$HUB_TOKEN" ] && [ "$HUB_TOKEN" != "CHANGEME" ]; then
    echo "  ✓ Hub token retrieved successfully"
  else
    echo "  ✗ Could not retrieve hub token from context '$HUB_CONTEXT'."
    echo "    Ensure the secret 'agentic-ai-server-secrets' exists in namespace '$HUB_NS'"
    echo "    and MCP_API_TOKEN is set. Use --hub-token <token> as fallback."
    HUB_TOKEN=""
  fi
fi

# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------
if [ "$ACTION" = "status" ]; then
  echo "============================================"
  echo " TCS Agentic AI — MCP Server Status"
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
  POD=$($CLI get pods -n "$NS" -l app.kubernetes.io/name=agentic-ai-agent -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
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
  echo " Removing TCS Agentic AI MCP Server"
  echo " Namespace: $NS"
  echo "============================================"
  echo ""
  echo " (The management bundle — dashboard, PostgreSQL, Redis — is NOT touched.)"
  echo ""
  read -p "Are you sure? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Cancelled."
    exit 0
  fi
  $CLI delete deployment "$DEPLOY_NAME" -n "$NS" --ignore-not-found
  $CLI delete service "$DEPLOY_NAME" -n "$NS" --ignore-not-found
  $CLI delete service "$DEPLOY_NAME-nodeport" -n "$NS" --ignore-not-found
  $CLI delete configmap agentic-ai-agent-config -n "$NS" --ignore-not-found
  $CLI delete secret agentic-ai-agent-secrets -n "$NS" --ignore-not-found
  $CLI delete serviceaccount agentic-ai-agent -n "$NS" --ignore-not-found
  $CLI delete clusterrolebinding agentic-ai-agent-reader-binding --ignore-not-found
  $CLI delete clusterrole agentic-ai-agent-reader --ignore-not-found
  # Transitional short-lived "mcp-server" names (renamed to agentic-ai-agent)
  $CLI delete deployment mcp-server -n "$NS" --ignore-not-found
  $CLI delete service mcp-server -n "$NS" --ignore-not-found
  $CLI delete service mcp-server-nodeport -n "$NS" --ignore-not-found
  $CLI delete configmap mcp-server-config -n "$NS" --ignore-not-found
  $CLI delete secret mcp-server-secrets -n "$NS" --ignore-not-found
  $CLI delete serviceaccount mcp-server -n "$NS" --ignore-not-found
  $CLI delete clusterrolebinding mcp-server-reader-binding --ignore-not-found
  $CLI delete clusterrole mcp-server-reader --ignore-not-found
  if [ "$PLATFORM" = "openshift" ]; then
    $CLI delete route mcp-server -n "$NS" --ignore-not-found
  fi
  if [ "$PLATFORM" = "openshift" ]; then
    $CLI delete route "$DEPLOY_NAME" -n "$NS" --ignore-not-found
  fi
  # Also remove an old-named spoke install, but never the control plane.
  OLD_MODE=$($CLI get configmap agentic-ai-server-config -n "$NS" -o jsonpath='{.data.MCP_MODE}' 2>/dev/null || echo "")
  if [ "$OLD_MODE" = "spoke" ]; then
    $CLI delete deployment agentic-ai-server -n "$NS" --ignore-not-found
    $CLI delete service agentic-ai-server -n "$NS" --ignore-not-found
    $CLI delete service agentic-ai-server-nodeport -n "$NS" --ignore-not-found
    $CLI delete configmap agentic-ai-server-config -n "$NS" --ignore-not-found
    $CLI delete secret agentic-ai-server-secrets -n "$NS" --ignore-not-found
    $CLI delete serviceaccount agentic-ai-server -n "$NS" --ignore-not-found
    $CLI delete clusterrolebinding agentic-ai-server-reader-binding --ignore-not-found
    $CLI delete clusterrole agentic-ai-server-reader --ignore-not-found
    if [ "$PLATFORM" = "openshift" ]; then
      $CLI delete route agentic-ai-server -n "$NS" --ignore-not-found
    fi
  fi
  echo ""
  echo "MCP server removed. The dashboard will mark this cluster as unreachable."
  echo "Remove the card via 'Remove Cluster' in the cluster picker."
  exit 0
fi

# ---------------------------------------------------------------------------
# Validate
# ---------------------------------------------------------------------------
if [ -z "$HUB_URL" ]; then
  echo "ERROR: --hub-url is required."
  echo "Usage: ./deploy/mcp/deploy.sh --hub-url https://<dashboard-route> --cluster-name my-cluster --platform openshift"
  exit 1
fi
if [ -z "$CLUSTER_NAME" ]; then
  echo "ERROR: --cluster-name is required."
  echo "Usage: ./deploy/mcp/deploy.sh --hub-url https://<dashboard-route> --cluster-name my-cluster --platform openshift"
  exit 1
fi

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------
STEPS=6
STEP=0
next() { STEP=$((STEP + 1)); echo ""; echo "[$STEP/$STEPS] $1"; }

echo "============================================"
echo " TCS Agentic AI — MCP Server Deployment"
echo "============================================"
echo " Cluster   : $CLUSTER_NAME"
echo " Platform  : $PLATFORM"
echo " Hub URL   : $HUB_URL"
echo " Hub Token : ${HUB_TOKEN:+(set)}${HUB_TOKEN:-(not set)}"
echo " Namespace : $NS"
echo " Image     : $IMAGE (same image on every cluster)"
echo " TLS skip  : $TLS_SKIP"
echo " Mode      : spoke (stateless — no DB, no PVC)"
echo "============================================"
echo ""

if [ -n "$HUB_URL" ] && [ -z "$HUB_TOKEN" ]; then
  echo "WARNING: No --hub-token provided. If the hub has AUTH_MODE=token,"
  echo "         spoke registration will fail with HTTP 401."
  echo "         Use: --hub-token <hub MCP_API_TOKEN value>"
  echo ""
fi

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
    app.kubernetes.io/name: agentic-ai-agent
    app.kubernetes.io/part-of: tcs-agentic-ai
EOF

# 1b. Migrate from earlier installs.
#   - Old per-cluster installs used the "agentic-ai-server" name family.
#     Remove them ONLY when they are spoke-mode — on the hub cluster that
#     name is the control plane (MCP_MODE=control) and must never be touched.
#   - The retired bundled hub-agent pod is replaced by this script.
OLD_MODE=$($CLI get configmap agentic-ai-server-config -n "$NS" -o jsonpath='{.data.MCP_MODE}' 2>/dev/null || echo "")
if [ "$OLD_MODE" = "spoke" ]; then
  echo "  Migrating: removing old spoke install (agentic-ai-server name family)..."
  $CLI delete deployment agentic-ai-server -n "$NS" --ignore-not-found 2>/dev/null || true
  $CLI delete service agentic-ai-server -n "$NS" --ignore-not-found 2>/dev/null || true
  $CLI delete service agentic-ai-server-nodeport -n "$NS" --ignore-not-found 2>/dev/null || true
  $CLI delete configmap agentic-ai-server-config -n "$NS" --ignore-not-found 2>/dev/null || true
  $CLI delete secret agentic-ai-server-secrets -n "$NS" --ignore-not-found 2>/dev/null || true
  $CLI delete serviceaccount agentic-ai-server -n "$NS" --ignore-not-found 2>/dev/null || true
  $CLI delete clusterrolebinding agentic-ai-server-reader-binding --ignore-not-found 2>/dev/null || true
  $CLI delete clusterrole agentic-ai-server-reader --ignore-not-found 2>/dev/null || true
  if [ "$CLI" = "oc" ]; then
    oc delete route agentic-ai-server -n "$NS" --ignore-not-found 2>/dev/null || true
  fi
fi
echo "  Removing retired hub-agent pod (if any)..."
$CLI delete deployment mcp-hub-agent -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete service mcp-hub-agent -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete configmap mcp-hub-agent-config -n "$NS" --ignore-not-found 2>/dev/null || true
# Transitional "mcp-server" names (renamed to agentic-ai-agent)
$CLI delete deployment mcp-server -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete service mcp-server -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete service mcp-server-nodeport -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete configmap mcp-server-config -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete secret mcp-server-secrets -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete serviceaccount mcp-server -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete clusterrolebinding mcp-server-reader-binding --ignore-not-found 2>/dev/null || true
$CLI delete clusterrole mcp-server-reader --ignore-not-found 2>/dev/null || true
if [ "$CLI" = "oc" ]; then
  oc delete route mcp-server -n "$NS" --ignore-not-found 2>/dev/null || true
fi
# Transitional "agentic-ai-mcp-server" names (renamed to agentic-ai-agent)
$CLI delete deployment agentic-ai-mcp-server -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete service agentic-ai-mcp-server -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete service agentic-ai-mcp-server-nodeport -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete configmap agentic-ai-mcp-server-config -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete secret agentic-ai-mcp-server-secrets -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete serviceaccount agentic-ai-mcp-server -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete clusterrolebinding agentic-ai-mcp-server-reader-binding --ignore-not-found 2>/dev/null || true
$CLI delete clusterrole agentic-ai-mcp-server-reader --ignore-not-found 2>/dev/null || true
if [ "$CLI" = "oc" ]; then
  oc delete route agentic-ai-mcp-server -n "$NS" --ignore-not-found 2>/dev/null || true
fi

# 2. ServiceAccount + RBAC (same as hub — full cluster-reader)
next "Creating service account and RBAC..."
cat <<EOF | $CLI apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: agentic-ai-agent
  namespace: $NS
  labels:
    app.kubernetes.io/name: agentic-ai-agent
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: agentic-ai-agent-reader
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
  name: agentic-ai-agent-reader-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: agentic-ai-agent-reader
subjects:
  - kind: ServiceAccount
    name: agentic-ai-agent
    namespace: $NS
EOF

# 3. ConfigMap + Secrets
next "Creating ConfigMap and Secrets..."
cat <<EOF | $CLI apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: agentic-ai-agent-config
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
  # Used by the self-redeploy endpoint (dashboard ⋮ → Redeploy)
  DEPLOYMENT_NAME: "$DEPLOY_NAME"
  MCP_NAMESPACE: "$NS"
---
apiVersion: v1
kind: Secret
metadata:
  name: agentic-ai-agent-secrets
  namespace: $NS
type: Opaque
stringData:
  MCP_API_TOKEN: ""
  HUB_API_TOKEN: "$HUB_TOKEN"
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
    app.kubernetes.io/name: agentic-ai-agent
    app.kubernetes.io/component: spoke
    app.kubernetes.io/part-of: tcs-agentic-ai
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: agentic-ai-agent
  template:
    metadata:
      labels:
        app.kubernetes.io/name: agentic-ai-agent
        tcs.com/mcp-mode: spoke
        tcs.com/cluster-name: "$CLUSTER_NAME"
    spec:
      serviceAccountName: agentic-ai-agent
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: agentic-ai-agent
          image: $IMAGE
          imagePullPolicy: Always
          ports:
            - containerPort: 3000
              name: http
          envFrom:
            - configMapRef:
                name: agentic-ai-agent-config
            - secretRef:
                name: agentic-ai-agent-secrets
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
    app.kubernetes.io/name: agentic-ai-agent
spec:
  selector:
    app.kubernetes.io/name: agentic-ai-agent
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
    app.kubernetes.io/name: agentic-ai-agent
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

# Detect external URL that the HUB will use to reach this spoke.
# Priority: --spoke-url override > Route hostname > internal service DNS
if [ -n "$SPOKE_URL_OVERRIDE" ]; then
  SPOKE_URL="$SPOKE_URL_OVERRIDE"
  echo "  Using provided spoke URL: $SPOKE_URL"
else
  if [ "$CLI" = "oc" ]; then
    SPOKE_URL=$(oc get route "$DEPLOY_NAME" -n "$NS" -o jsonpath='https://{.spec.host}' 2>/dev/null || echo "")
  fi
  if [ -z "$SPOKE_URL" ]; then
    SPOKE_URL="http://${DEPLOY_NAME}.${NS}.svc.cluster.local:3000"
  fi
  echo "  Auto-detected spoke URL: $SPOKE_URL"

  # Cross-cluster DNS check: extract hostname and verify the hub can resolve it
  SPOKE_HOST=$(echo "$SPOKE_URL" | sed 's|https\?://||' | cut -d/ -f1 | cut -d: -f1)
  HUB_HOST=$(echo "$HUB_URL" | sed 's|https\?://||' | cut -d/ -f1 | cut -d: -f1)
  SPOKE_DOMAIN=$(echo "$SPOKE_HOST" | sed 's/^[^.]*\.//')
  HUB_DOMAIN=$(echo "$HUB_HOST" | sed 's/^[^.]*\.//')
  if [ "$SPOKE_DOMAIN" != "$HUB_DOMAIN" ]; then
    echo ""
    echo "  WARNING: Spoke and hub are on different DNS domains:"
    echo "    Hub:   $HUB_DOMAIN"
    echo "    Spoke: $SPOKE_DOMAIN"
    echo ""
    echo "  The hub may not be able to resolve '$SPOKE_HOST'."
    echo "  If dashboard shows 502/ENOTFOUND errors, redeploy with:"
    echo "    --spoke-url http://<spoke-node-ip>:<nodeport>"
    echo "  or add DNS entries for the spoke domain on the hub cluster."
    echo ""

    # Try to get a routable IP address as fallback
    SPOKE_NODE_IP=$($CLI get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || echo "")
    if [ -n "$SPOKE_NODE_IP" ]; then
      # Create a NodePort service for cross-cluster access
      echo "  Creating NodePort service for cross-cluster access..."
      cat <<NPEOF | $CLI apply -f -
apiVersion: v1
kind: Service
metadata:
  name: agentic-ai-agent-nodeport
  namespace: $NS
spec:
  type: NodePort
  selector:
    app.kubernetes.io/name: agentic-ai-agent
  ports:
    - port: 3000
      targetPort: 3000
      protocol: TCP
      name: http
NPEOF
      NP=$($CLI get svc agentic-ai-agent-nodeport -n "$NS" -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null || echo "")
      if [ -n "$NP" ]; then
        SPOKE_URL="http://${SPOKE_NODE_IP}:${NP}"
        echo "  Using NodePort URL: $SPOKE_URL"
      fi
    fi
  fi
fi

# 6. Update ConfigMap with spoke external URL and restart
next "Configuring spoke external URL and restarting..."
$CLI patch configmap agentic-ai-agent-config -n "$NS" --type merge -p "{\"data\":{\"SPOKE_EXTERNAL_URL\":\"$SPOKE_URL\"}}"
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
  echo "  Check spoke logs: $CLI logs -n $NS -l app.kubernetes.io/name=agentic-ai-agent --tail=30"
  echo ""
  echo "  Common issues:"
  echo "    - Hub unreachable from this cluster (network/firewall)"
  echo "    - TLS errors: add --tls-skip flag"
  echo "    - DNS: verify hub hostname resolves from spoke cluster"
  echo "    - 502 ENOTFOUND: hub can't resolve spoke URL — use --spoke-url http://<ip>:<port>"
fi

echo ""
echo "============================================"
echo " MCP server deployment complete!"
echo "============================================"
echo ""
echo " Cluster       : $CLUSTER_NAME"
echo " Platform      : $PLATFORM"
echo " Hub           : $HUB_URL"
echo " Reach-back URL: $SPOKE_URL"
echo " Namespace     : $NS"
echo " Image         : $IMAGE (same image on every cluster)"
echo " Mode          : spoke (stateless — no DB, no PVC)"
echo ""
echo " Every cluster runs this SAME stateless pod. When users query this"
echo " cluster from the dashboard, the control plane proxies to this pod —"
echo " identical answers guaranteed across the whole fleet."
echo ""
if [ "$CLUSTER_NAME" = "hub-cluster" ]; then
  echo " Registered as 'hub-cluster' — the management cluster's own data plane"
  echo " (no separate card; the picker's hub card now uses this pod)."
else
  echo " The cluster now appears in the dashboard's 'Select a Cluster' workspace."
fi
echo ""
echo " Management:"
echo "   ./deploy/mcp/deploy.sh --status        # Check MCP server status"
echo "   ./deploy/mcp/deploy.sh --rollback      # Rollback MCP server"
echo "   ./deploy/mcp/deploy.sh --uninstall     # Remove MCP server"
echo "   $CLI logs -n $NS -l app.kubernetes.io/name=agentic-ai-agent -f"
echo ""
echo " Image updates: click ⋮ → Redeploy on the cluster card — no script rerun."
echo "============================================"
