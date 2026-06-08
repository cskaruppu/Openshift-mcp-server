#!/usr/bin/env bash
# ============================================================================
# TCS Agentic AI — Hub Cluster Deployment
# ============================================================================
#
# Deploys the MCP Gateway (hub server + dashboard + database) to the primary
# OpenShift/Kubernetes cluster. This is the control plane that all secondary
# cluster agents connect to.
#
# Prerequisites:
#   - oc (OpenShift) or kubectl logged in to the hub cluster
#   - podman or docker available for image builds
#   - quay.io login configured (podman login quay.io)
#
# Usage:
#   ./deploy-hub.sh                     # Full deploy (build + push + apply)
#   ./deploy-hub.sh --no-build          # Apply manifests only (image already pushed)
#   ./deploy-hub.sh --no-pull           # Skip git pull
#   ./deploy-hub.sh -n custom-namespace # Custom namespace (default: openshift-mcp)
#   ./deploy-hub.sh --status            # Check current deployment status
#   ./deploy-hub.sh --rollback          # Rollback to previous revision
#
# Environment variables (optional):
#   IMAGE          - Override image (default: quay.io/karuppucs/openshift-mcp-server:latest)
#   AUTH_MODE      - token | password | none (default: token)
#   LLM_PROVIDER   - azure | openai | anthropic | ollama | none
#
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
NS="${NAMESPACE:-openshift-mcp}"
IMAGE="${IMAGE:-quay.io/karuppucs/openshift-mcp-server:latest}"
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
# Helper functions
# ---------------------------------------------------------------------------
STEPS=0
STEP=0
next() { STEP=$((STEP + 1)); echo ""; echo "[$STEP/$STEPS] $1"; }

hub_url() {
  if [ "$CLI" = "oc" ]; then
    oc get route mcp-server -n "$NS" -o jsonpath='https://{.spec.host}' 2>/dev/null || echo ""
  else
    kubectl get ingress mcp-server -n "$NS" -o jsonpath='https://{.spec.rules[0].host}' 2>/dev/null || echo ""
  fi
}

# ---------------------------------------------------------------------------
# Status check
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
    curl -sk "${URL}/healthz" 2>/dev/null | head -c 200 || echo "  Cannot reach hub"
    echo ""
    echo ""
    echo "--- Connected Agents ---"
    curl -sk "${URL}/api/agent/status" 2>/dev/null | head -c 500 || echo "  Cannot reach hub"
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
  echo "Rolling back mcp-server deployment..."
  $CLI rollout undo deployment/mcp-server -n "$NS"
  echo "Waiting for rollout..."
  $CLI rollout status deployment/mcp-server -n "$NS" --timeout=120s
  echo ""
  echo "Rollback complete."
  $CLI get pods -n "$NS" -o wide
  exit 0
fi

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------
STEPS=7

echo "============================================"
echo " TCS Agentic AI — Hub Deployment"
echo "============================================"
echo " Namespace : $NS"
echo " Image     : $IMAGE"
echo " Build     : $BUILD"
echo " CLI       : $CLI"
echo " Runtime   : ${RUNTIME:-'(none — build disabled)'}"
echo "============================================"

# 1. Git pull
next "Pulling latest code..."
if $GIT_PULL && [ -d "$REPO_ROOT/.git" ]; then
  cd "$REPO_ROOT"
  BRANCH="${DEPLOY_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
  git fetch origin "$BRANCH" 2>/dev/null || true
  git pull origin "$BRANCH" --rebase 2>/dev/null || echo "  (pull skipped — no remote or conflicts)"
  echo "  Branch: $BRANCH"
  echo "  Commit: $(git log --oneline -1)"
else
  echo "  Skipped"
fi

# 2. Build and push image
next "Building container image..."
if $BUILD; then
  if [ -z "$RUNTIME" ]; then
    echo "  ERROR: No container runtime (podman/docker) found. Use --no-build."
    exit 1
  fi
  cd "$REPO_ROOT"
  $RUNTIME build -t "$IMAGE" -f Dockerfile .
  echo "  Built: $IMAGE"
  echo "  Pushing to registry..."

  ATTEMPT=0; MAX=4; DELAY=2
  while [ $ATTEMPT -lt $MAX ]; do
    if $RUNTIME push "$IMAGE" 2>&1; then
      echo "  Push complete."
      break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    if [ $ATTEMPT -lt $MAX ]; then
      echo "  Push failed (attempt $ATTEMPT/$MAX). Retrying in ${DELAY}s..."
      sleep $DELAY; DELAY=$((DELAY * 2))
    else
      echo "  ERROR: Push failed after $MAX attempts."
      exit 1
    fi
  done
else
  echo "  Skipped (--no-build)"
fi

# 3. Create namespace and RBAC
next "Applying namespace, service account, RBAC..."
$CLI apply -f "$K8S_DIR/namespace.yaml"
# Update namespace in manifests if non-default
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
$CLI apply -f "$K8S_DIR/networkpolicy.yaml" 2>/dev/null || echo "  (network policy skipped — CRD may not exist)"

# 5. Persistent storage and data stores
next "Deploying persistent storage, PostgreSQL, Redis..."
$CLI apply -f "$K8S_DIR/pvc.yaml"
$CLI apply -f "$K8S_DIR/postgres.yaml" 2>&1 | grep -v "is invalid" || true
$CLI apply -f "$K8S_DIR/redis.yaml" 2>&1 | grep -v "is invalid" || true

# 6. MCP server + service + route
next "Deploying MCP server..."
sed -i "s|image:.*openshift-mcp-server:.*|image: ${IMAGE}|" "$K8S_DIR/deployment.yaml"
$CLI apply -f "$K8S_DIR/deployment.yaml"
$CLI apply -f "$K8S_DIR/service.yaml"
$CLI set image deployment/mcp-server mcp-server="$IMAGE" -n "$NS" 2>/dev/null || true

# 7. Rollout and verify
next "Rolling out and verifying..."
$CLI rollout restart deployment/mcp-server -n "$NS"
echo "  Waiting for rollout..."
$CLI rollout status deployment/mcp-server -n "$NS" --timeout=180s

echo ""
echo "--- Pod Status ---"
$CLI get pods -n "$NS" -o wide
echo ""

URL=$(hub_url)

echo "============================================"
echo " Hub deployment complete!"
echo "============================================"
echo ""
if [ -n "$URL" ]; then
  echo " Dashboard   : $URL"
  echo " API         : $URL/api/"
  echo " MCP (SSE)   : $URL/sse"
  echo " Health      : $URL/healthz"
  echo " Agent Status: $URL/api/agent/status"
else
  echo " No route/ingress found."
  echo " Access via: $CLI port-forward svc/mcp-server 3000:3000 -n $NS"
fi
echo ""
echo " Commit: $(git -C "$REPO_ROOT" log --oneline -1 2>/dev/null || echo 'N/A')"
echo ""
echo " Next step: Deploy agents on secondary clusters using:"
echo "   ./deploy-agent.sh --hub-url $URL --cluster-name <name> --platform <platform>"
echo "============================================"
