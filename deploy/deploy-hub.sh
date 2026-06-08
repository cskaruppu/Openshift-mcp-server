#!/usr/bin/env bash
# ============================================================================
# TCS Agentic AI — Hub Cluster Deployment
# ============================================================================
#
# Deploys the full hub stack to the primary cluster:
#   1. MCP Server (API-only, cluster operations + federation)
#   2. Dashboard (React + Nginx, separate pod)
#   3. PostgreSQL (persistent storage)
#   4. Redis (caching)
#
# This follows the ACM pattern: dashboard and API are separate pods.
# Spoke clusters only get the MCP server — no dashboard, no database.
#
# Prerequisites:
#   - oc (OpenShift) or kubectl logged in to the hub cluster
#   - podman or docker available for image builds
#   - quay.io login configured (podman login quay.io)
#
# Usage:
#   ./deploy-hub.sh                     # Full deploy (build + push + apply)
#   ./deploy-hub.sh --no-build          # Apply manifests only (images already pushed)
#   ./deploy-hub.sh --no-pull           # Skip git pull
#   -n custom-namespace                 # Custom namespace (default: openshift-mcp)
#   ./deploy-hub.sh --status            # Check current deployment status
#   ./deploy-hub.sh --rollback          # Rollback to previous revision
#
# Environment variables (optional):
#   MCP_IMAGE       - Override MCP server image
#   DASHBOARD_IMAGE - Override dashboard image
#   AUTH_MODE       - token | password | none (default: token)
#   LLM_PROVIDER    - azure | openai | anthropic | ollama | none
#
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
NS="${NAMESPACE:-openshift-mcp}"
MCP_IMAGE="${MCP_IMAGE:-quay.io/karuppucs/openshift-mcp-server:latest}"
DASHBOARD_IMAGE="${DASHBOARD_IMAGE:-quay.io/karuppucs/tcs-agentic-dashboard:latest}"
BUILD=true
GIT_PULL=true
ACTION="deploy"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
K8S_DIR="$REPO_ROOT/k8s"

# Detect CLI (oc or kubectl)
if command -v oc &>/dev/null; then
  CLI="oc"
elif command -v kubectl &>/dev/null; then
  CLI="kubectl"
else
  echo "ERROR: Neither 'oc' nor 'kubectl' found. Install one first."
  exit 1
fi

# Detect container runtime
if command -v podman &>/dev/null; then
  RUNTIME="podman"
elif command -v docker &>/dev/null; then
  RUNTIME="docker"
else
  RUNTIME=""
fi

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--namespace)  NS="$2"; shift 2 ;;
    --no-build)      BUILD=false; shift ;;
    --no-pull)       GIT_PULL=false; shift ;;
    --status)        ACTION="status"; shift ;;
    --rollback)      ACTION="rollback"; shift ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
STEPS=0
STEP=0
next() { STEP=$((STEP + 1)); echo ""; echo "[$STEP/$STEPS] $1"; }

hub_url() {
  if [ "$CLI" = "oc" ]; then
    oc get route tcs-dashboard -n "$NS" -o jsonpath='https://{.spec.host}' 2>/dev/null || echo ""
  else
    kubectl get ingress tcs-dashboard -n "$NS" -o jsonpath='https://{.spec.rules[0].host}' 2>/dev/null || echo ""
  fi
}

push_with_retry() {
  local img="$1"
  local attempt=0 max=4 delay=2
  while [ $attempt -lt $max ]; do
    if $RUNTIME push "$img" 2>&1; then
      echo "  Push complete: $img"
      return 0
    fi
    attempt=$((attempt + 1))
    if [ $attempt -lt $max ]; then
      echo "  Push failed (attempt $attempt/$max). Retrying in ${delay}s..."
      sleep $delay; delay=$((delay * 2))
    else
      echo "  ERROR: Push failed after $max attempts."
      return 1
    fi
  done
}

# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------
if [ "$ACTION" = "status" ]; then
  echo "============================================"
  echo " TCS Agentic AI — Hub Status"
  echo " Namespace: $NS"
  echo "============================================"
  echo ""
  echo "--- Pods ---"
  $CLI get pods -n "$NS" -o wide 2>/dev/null || echo "  No pods found"
  echo ""
  echo "--- Deployments ---"
  $CLI get deploy -n "$NS" 2>/dev/null || echo "  No deployments found"
  echo ""
  echo "--- Services ---"
  $CLI get svc -n "$NS" 2>/dev/null || echo "  No services found"
  echo ""
  if [ "$CLI" = "oc" ]; then
    echo "--- Routes ---"
    oc get routes -n "$NS" 2>/dev/null || echo "  No routes found"
  fi
  echo ""
  URL=$(hub_url)
  if [ -n "$URL" ]; then
    echo "--- Health Check ---"
    echo "  Dashboard: $(curl -sk -o /dev/null -w '%{http_code}' "${URL}/nginx-health" 2>/dev/null || echo 'unreachable')"
    echo "  MCP API:   $(curl -sk "${URL}/api/auth/status" 2>/dev/null | head -c 200 || echo 'unreachable')"
    echo ""
    echo "--- Connected Spokes ---"
    curl -sk "${URL}/api/spoke/status" 2>/dev/null | head -c 500 || echo "  Cannot reach hub"
    echo ""
  fi
  echo ""
  echo "Dashboard: ${URL:-'(no route/ingress found)'}"
  exit 0
fi

# ---------------------------------------------------------------------------
# Rollback
# ---------------------------------------------------------------------------
if [ "$ACTION" = "rollback" ]; then
  echo "============================================"
  echo " TCS Agentic AI — Hub Rollback"
  echo " Namespace: $NS"
  echo "============================================"
  echo ""
  echo "Rolling back MCP server..."
  $CLI rollout undo deployment/mcp-server -n "$NS"
  echo "Rolling back dashboard..."
  $CLI rollout undo deployment/tcs-dashboard -n "$NS"
  echo "Waiting for rollout..."
  $CLI rollout status deployment/mcp-server -n "$NS" --timeout=120s
  $CLI rollout status deployment/tcs-dashboard -n "$NS" --timeout=120s
  echo ""
  echo "Rollback complete."
  $CLI get pods -n "$NS" -o wide
  exit 0
fi

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------
STEPS=9

echo "============================================"
echo " TCS Agentic AI — Hub Deployment"
echo "============================================"
echo " Namespace       : $NS"
echo " MCP Server Image: $MCP_IMAGE"
echo " Dashboard Image : $DASHBOARD_IMAGE"
echo " Build           : $BUILD"
echo " CLI             : $CLI"
echo " Runtime         : ${RUNTIME:-'(none — build disabled)'}"
echo ""
echo " Components:"
echo "   [1] MCP Server  — API + cluster operations + federation"
echo "   [2] Dashboard    — React + Nginx (separate pod)"
echo "   [3] PostgreSQL   — persistent storage"
echo "   [4] Redis        — caching"
echo "============================================"

# 1. Git pull
next "Pulling latest code..."
if $GIT_PULL && [ -d "$REPO_ROOT/.git" ]; then
  cd "$REPO_ROOT"
  BRANCH="${DEPLOY_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
  git fetch origin "$BRANCH" 2>/dev/null || true
  git pull origin "$BRANCH" --rebase 2>/dev/null || echo "  (pull skipped)"
  echo "  Branch: $BRANCH — $(git log --oneline -1)"
else
  echo "  Skipped"
fi

# 2. Build and push BOTH images
next "Building container images..."
if $BUILD; then
  if [ -z "$RUNTIME" ]; then
    echo "  ERROR: No container runtime found. Use --no-build."
    exit 1
  fi
  cd "$REPO_ROOT"

  echo "  [a] Building MCP server image..."
  $RUNTIME build -t "$MCP_IMAGE" -f Dockerfile .
  echo "  [b] Building Dashboard image..."
  $RUNTIME build -t "$DASHBOARD_IMAGE" -f dashboard-react/Dockerfile dashboard-react/

  echo "  Pushing images..."
  push_with_retry "$MCP_IMAGE"
  push_with_retry "$DASHBOARD_IMAGE"
else
  echo "  Skipped (--no-build)"
fi

# 3. Namespace and RBAC
next "Applying namespace, service account, RBAC..."
$CLI apply -f "$K8S_DIR/namespace.yaml"
if [ "$NS" != "openshift-mcp" ]; then
  echo "  (Patching manifests for namespace: $NS)"
  for f in "$K8S_DIR"/*.yaml; do
    sed -i "s/namespace: openshift-mcp/namespace: $NS/g" "$f"
  done
fi
$CLI apply -f "$K8S_DIR/serviceaccount.yaml"

# 4. Secrets and config
next "Applying secrets, configmap, network policy..."
$CLI apply -f "$K8S_DIR/secret.yaml"
$CLI apply -f "$K8S_DIR/configmap.yaml"
$CLI apply -f "$K8S_DIR/networkpolicy.yaml" 2>/dev/null || true

# 5. Persistent storage and data stores
next "Deploying PostgreSQL and Redis..."
$CLI apply -f "$K8S_DIR/pvc.yaml"
$CLI apply -f "$K8S_DIR/postgres.yaml" 2>&1 | grep -v "is invalid" || true
$CLI apply -f "$K8S_DIR/redis.yaml" 2>&1 | grep -v "is invalid" || true

# 6. MCP Server deployment
next "Deploying MCP server (API-only)..."
sed -i "s|image:.*openshift-mcp-server:.*|image: ${MCP_IMAGE}|" "$K8S_DIR/deployment.yaml"
$CLI apply -f "$K8S_DIR/deployment.yaml"
$CLI apply -f "$K8S_DIR/service.yaml"
$CLI set image deployment/mcp-server mcp-server="$MCP_IMAGE" -n "$NS" 2>/dev/null || true

# 7. Dashboard deployment (separate pod)
next "Deploying Dashboard (React + Nginx)..."
cat <<EOF | $CLI apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tcs-dashboard
  namespace: $NS
  labels:
    app.kubernetes.io/name: tcs-dashboard
    app.kubernetes.io/component: dashboard
    app.kubernetes.io/part-of: mcp-ai-assistant
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: tcs-dashboard
  template:
    metadata:
      labels:
        app.kubernetes.io/name: tcs-dashboard
    spec:
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: dashboard
          image: $DASHBOARD_IMAGE
          imagePullPolicy: Always
          ports:
            - containerPort: 8080
              name: http
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          readinessProbe:
            httpGet:
              path: /nginx-health
              port: 8080
            initialDelaySeconds: 3
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /nginx-health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 30
---
apiVersion: v1
kind: Service
metadata:
  name: tcs-dashboard
  namespace: $NS
  labels:
    app.kubernetes.io/name: tcs-dashboard
    app.kubernetes.io/part-of: mcp-ai-assistant
spec:
  selector:
    app.kubernetes.io/name: tcs-dashboard
  ports:
    - port: 8080
      targetPort: 8080
      name: http
EOF

# Route/Ingress — point to dashboard (which proxies /api to MCP server)
if [ "$CLI" = "oc" ]; then
  cat <<EOF | $CLI apply -f -
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: tcs-dashboard
  namespace: $NS
  labels:
    app.kubernetes.io/name: tcs-dashboard
    app.kubernetes.io/part-of: mcp-ai-assistant
  annotations:
    haproxy.router.openshift.io/timeout: 600s
    haproxy.router.openshift.io/timeout-tunnel: 600s
    haproxy.router.openshift.io/disable_cookies: "true"
spec:
  to:
    kind: Service
    name: tcs-dashboard
  port:
    targetPort: http
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect
EOF
fi

# 8. Rollout and verify
next "Rolling out and verifying..."
$CLI rollout restart deployment/mcp-server -n "$NS"
$CLI rollout restart deployment/tcs-dashboard -n "$NS"
echo "  Waiting for MCP server..."
$CLI rollout status deployment/mcp-server -n "$NS" --timeout=180s
echo "  Waiting for Dashboard..."
$CLI rollout status deployment/tcs-dashboard -n "$NS" --timeout=120s

echo ""
echo "--- Pod Status ---"
$CLI get pods -n "$NS" -o wide
echo ""

URL=$(hub_url)

# 9. Summary
next "Deployment complete!"

echo ""
echo "============================================"
echo " Hub deployment complete!"
echo "============================================"
echo ""
echo " Components deployed:"
echo "   ✓ MCP Server   : $MCP_IMAGE"
echo "   ✓ Dashboard     : $DASHBOARD_IMAGE"
echo "   ✓ PostgreSQL    : persistent storage"
echo "   ✓ Redis         : caching"
echo ""
if [ -n "$URL" ]; then
  echo " Dashboard     : $URL"
  echo " API (via nginx): $URL/api/"
  echo " MCP (SSE)     : $URL/sse"
  echo " Health        : $URL/nginx-health"
  echo " Spoke Status  : $URL/api/spoke/status"
else
  echo " No route/ingress found."
  echo " Access via: $CLI port-forward svc/tcs-dashboard 8080:8080 -n $NS"
fi
echo ""
echo " Commit: $(git -C "$REPO_ROOT" log --oneline -1 2>/dev/null || echo 'N/A')"
echo ""
echo " Next: Deploy spokes on secondary clusters:"
echo "   ./deploy-spoke.sh --hub-url $URL --cluster-name <name> --platform <platform>"
echo "============================================"
