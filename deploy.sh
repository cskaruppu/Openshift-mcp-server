#!/bin/bash
# ============================================================================
# OpenShift MCP AI Assistant — Deploy Script
# ============================================================================
#
# Usage:
#   ./deploy.sh                    # Full deploy: git pull, build, push, deploy
#   ./deploy.sh --no-build         # Deploy manifests only (skip image build)
#   ./deploy.sh --no-pull          # Skip git pull
#   ./deploy.sh -n my-namespace    # Deploy to custom namespace
#
# Examples:
#   ./deploy.sh                    # Pull latest code, build image, deploy all
#   ./deploy.sh --no-build         # Just apply k8s manifests and restart
#   ./deploy.sh --no-pull --no-build  # Only restart the deployment
#
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
NS="openshift-mcp"
BUILD=true
GIT_PULL=true
IMAGE="quay.io/karuppucs/openshift-mcp-server:latest"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--namespace)  NS="$2"; shift 2 ;;
    --no-build)      BUILD=false; shift ;;
    --no-pull)       GIT_PULL=false; shift ;;
    --build)         BUILD=true; shift ;;
    -h|--help)
      echo "Usage: ./deploy.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  -n, --namespace NS   Target namespace (default: openshift-mcp)"
      echo "  --no-build           Skip Docker build and push"
      echo "  --no-pull            Skip git pull"
      echo "  --build              Force build (default)"
      echo "  -h, --help           Show this help"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
K8S_DIR="$SCRIPT_DIR/k8s"

STEPS=7
STEP=0
next() { STEP=$((STEP + 1)); echo ""; echo "[$STEP/$STEPS] $1"; }

echo "============================================"
echo " OpenShift MCP AI Assistant — Deploying"
echo " Namespace : $NS"
echo " Image     : $IMAGE"
echo " Build     : $BUILD"
echo " Git pull  : $GIT_PULL"
echo "============================================"

# ---------------------------------------------------------------------------
# 1. Git pull latest code
# ---------------------------------------------------------------------------
next "Pulling latest code..."
if $GIT_PULL; then
  cd "$SCRIPT_DIR"
  DEPLOY_BRANCH="claude/setup-mcp-openshift-9JUo7"
  CURRENT=$(git rev-parse --abbrev-ref HEAD)
  if [ "$CURRENT" != "$DEPLOY_BRANCH" ]; then
    echo "       Switching from $CURRENT to $DEPLOY_BRANCH..."
    git fetch origin "$DEPLOY_BRANCH"
    git checkout "$DEPLOY_BRANCH" 2>/dev/null || git checkout -b "$DEPLOY_BRANCH" "origin/$DEPLOY_BRANCH"
  fi
  echo "       Branch: $DEPLOY_BRANCH"
  # Clean up any stale rebase state
  git rebase --abort 2>/dev/null || true
  rm -fr "$SCRIPT_DIR/.git/rebase-apply" "$SCRIPT_DIR/.git/rebase-merge" 2>/dev/null || true
  git fetch origin "$DEPLOY_BRANCH"
  git reset --hard "origin/$DEPLOY_BRANCH"
  echo "       Commit: $(git log --oneline -1)"
else
  echo "       Skipped (--no-pull)"
fi

# ---------------------------------------------------------------------------
# 2. Build and push container image
# ---------------------------------------------------------------------------
next "Building container image..."
if $BUILD; then
  cd "$SCRIPT_DIR"
  podman build -t "$IMAGE" .
  echo "       Build complete. Pushing to registry..."
  podman push "$IMAGE"
  echo "       Image pushed: $IMAGE"
else
  echo "       Skipped (--no-build)"
fi

# ---------------------------------------------------------------------------
# 3. Create namespace, RBAC, config, secrets
# ---------------------------------------------------------------------------
next "Applying namespace, service account, RBAC, config..."
oc apply -f "$K8S_DIR/namespace.yaml"
oc apply -f "$K8S_DIR/serviceaccount.yaml"
oc apply -f "$K8S_DIR/secret.yaml"
oc apply -f "$K8S_DIR/configmap.yaml"
oc apply -f "$K8S_DIR/networkpolicy.yaml"

# ---------------------------------------------------------------------------
# 4. Persistent storage
# ---------------------------------------------------------------------------
next "Applying persistent volume claims..."
oc apply -f "$K8S_DIR/pvc.yaml"

# ---------------------------------------------------------------------------
# 5. Data stores
# ---------------------------------------------------------------------------
next "Deploying PostgreSQL and Redis..."
oc apply -f "$K8S_DIR/postgres.yaml" 2>&1 | grep -v "is invalid" || true
oc apply -f "$K8S_DIR/redis.yaml" 2>&1 | grep -v "is invalid" || true

# ---------------------------------------------------------------------------
# 6. MCP Server + Service + Route
# ---------------------------------------------------------------------------
next "Deploying MCP server..."
# Ensure deployment.yaml uses the correct image before applying
sed -i "s|image:.*openshift-mcp-server:.*|image: ${IMAGE}|" "$K8S_DIR/deployment.yaml"
oc apply -f "$K8S_DIR/deployment.yaml"
oc apply -f "$K8S_DIR/service.yaml"
# Force the image in the live deployment in case YAML had a stale tag
oc set image deployment/mcp-server mcp-server="$IMAGE" -n "$NS"

# ---------------------------------------------------------------------------
# 7. Rollout and verify
# ---------------------------------------------------------------------------
next "Rolling out and verifying..."
oc rollout restart deployment/mcp-server -n "$NS"
echo "       Waiting for rollout to complete..."
oc rollout status deployment/mcp-server -n "$NS" --timeout=180s

echo ""
echo "--- Pod Status ---"
oc get pods -n "$NS" -o wide
echo ""

ROUTE=$(oc get route mcp-server -n "$NS" -o jsonpath='{.spec.host}' 2>/dev/null || echo "")
echo "============================================"
echo " Deployment complete!"
echo ""
if [ -n "$ROUTE" ]; then
  echo " Dashboard:  https://$ROUTE"
  echo " API:        https://$ROUTE/api/"
  echo " MCP (SSE):  https://$ROUTE/sse"
  echo " Health:     https://$ROUTE/healthz"
fi
echo ""
echo " Commit: $(git log --oneline -1 2>/dev/null || echo 'N/A')"
echo "============================================"
