#!/bin/bash
# ============================================================================
# OpenShift MCP AI Assistant — Deploy Script
# ============================================================================
#
# Usage:
#   ./deploy.sh                    # Deploy to default namespace (openshift-mcp)
#   ./deploy.sh my-namespace       # Deploy to custom namespace
#   ./deploy.sh --build            # Build container image and deploy
#
# Architecture:
#   ┌─────────────┐     ┌──────────────┐     ┌─────────────┐
#   │   Browser    │────▶│  mcp-server  │────▶│  OpenShift   │
#   │  Dashboard   │◀────│  (API + UI)  │◀────│  API Server  │
#   └─────────────┘     └──────┬───────┘     └─────────────┘
#                              │
#                     ┌────────┴────────┐
#                     │                 │
#               ┌─────▼─────┐   ┌──────▼──────┐
#               │ PostgreSQL │   │    Redis     │
#               │  (history) │   │   (cache)    │
#               └───────────┘   └─────────────┘
#
# ============================================================================

set -euo pipefail

NS="${1:-openshift-mcp}"
BUILD=false
IMAGE="quay.io/your-org/openshift-mcp-server:latest"

for arg in "$@"; do
  case "$arg" in
    --build) BUILD=true ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
K8S_DIR="$SCRIPT_DIR/k8s"

echo "============================================"
echo " OpenShift MCP AI Assistant — Deploying"
echo " Namespace: $NS"
echo "============================================"
echo ""

# 0. Build container image (optional)
if $BUILD; then
  echo "[1/6] Building container image..."
  docker build -t "$IMAGE" "$SCRIPT_DIR"
  docker push "$IMAGE"
  echo "       Image pushed: $IMAGE"
else
  echo "[1/6] Skipping build (use --build to build image)"
fi

# 1. Namespace, RBAC, config
echo "[2/6] Creating namespace, service account, RBAC..."
oc apply -f "$K8S_DIR/namespace.yaml"
oc apply -f "$K8S_DIR/serviceaccount.yaml"
oc apply -f "$K8S_DIR/secret.yaml"
oc apply -f "$K8S_DIR/configmap.yaml"
oc apply -f "$K8S_DIR/networkpolicy.yaml"

# 2. Data stores (ignore StatefulSet immutable field errors for existing deployments)
echo "[3/6] Deploying PostgreSQL and Redis..."
oc apply -f "$K8S_DIR/postgres.yaml" 2>&1 | grep -v "is invalid" || true
oc apply -f "$K8S_DIR/redis.yaml"

# 3. MCP Server (serves both API and dashboard)
echo "[4/6] Deploying MCP server..."
oc apply -f "$K8S_DIR/deployment.yaml"
oc apply -f "$K8S_DIR/service.yaml"

# 4. Roll out
echo "[5/6] Rolling out..."
oc rollout restart deployment/mcp-server -n "$NS"
oc rollout status deployment/mcp-server -n "$NS" --timeout=120s

# 5. Print access info
echo ""
echo "[6/6] Verifying..."
echo ""
oc get pods -n "$NS"
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
echo " Configure LLM providers in Settings tab"
echo "============================================"
