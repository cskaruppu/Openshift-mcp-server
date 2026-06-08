#!/bin/bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════
# TCS Agentic AI — Multi-Cluster Deployment Script
#
# Usage:
#   ./deploy/deploy-all.sh                    # Deploy to all clusters
#   ./deploy/deploy-all.sh prod-us-east       # Deploy to specific cluster
#   ./deploy/deploy-all.sh --rollback         # Rollback all clusters
#   ./deploy/deploy-all.sh --status           # Check status on all clusters
# ═══════════════════════════════════════════════════════════════

IMAGE="${TCS_IMAGE:-your-registry/tcs-agentic-ai:latest}"
NAMESPACE="${TCS_NAMESPACE:-openshift-tcs-agentic}"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"

# Add your cluster contexts here
CLUSTERS=(
  "hub-cluster"
  # "prod-us-east"
  # "prod-eu-west"
  # "staging"
)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
log_warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
log_err()  { echo -e "  ${RED}✗${NC} $1"; }

switch_context() {
  oc config use-context "$1" 2>/dev/null || kubectl config use-context "$1" 2>/dev/null
}

# ── Rollback mode ──
if [ "${1:-}" = "--rollback" ]; then
  echo "=== Rolling back all clusters ==="
  for ctx in "${CLUSTERS[@]}"; do
    echo "→ Rolling back $ctx..."
    switch_context "$ctx"
    if oc rollout undo deployment/tcs-agentic-ai -n "$NAMESPACE" 2>/dev/null; then
      log_ok "$ctx rolled back"
    else
      log_err "$ctx rollback failed"
    fi
  done
  exit 0
fi

# ── Status mode ──
if [ "${1:-}" = "--status" ]; then
  echo "=== Cluster Status ==="
  for ctx in "${CLUSTERS[@]}"; do
    switch_context "$ctx" 2>/dev/null
    READY=$(oc get deployment tcs-agentic-ai -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
    VERSION=$(oc get deployment tcs-agentic-ai -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "unknown")
    ROUTE=$(oc get route tcs-agentic-ai -n "$NAMESPACE" -o jsonpath='{.spec.host}' 2>/dev/null || echo "no-route")
    if [ "$READY" = "1" ]; then
      log_ok "$ctx — Ready (${VERSION}) — https://$ROUTE"
    else
      log_err "$ctx — Not Ready (replicas: ${READY:-0})"
    fi
  done
  exit 0
fi

# ── Single cluster mode ──
if [ -n "${1:-}" ] && [ "$1" != "--rollback" ] && [ "$1" != "--status" ]; then
  CLUSTERS=("$1")
fi

echo "=== TCS Agentic AI — Multi-Cluster Deployment ==="
echo "Image:     $IMAGE"
echo "Namespace: $NAMESPACE"
echo "Clusters:  ${CLUSTERS[*]}"
echo ""

# Step 1: Build and push
echo "[1/4] Building container image..."
if docker build -t "$IMAGE" "$DEPLOY_DIR/.."; then
  docker push "$IMAGE"
  log_ok "Image pushed: $IMAGE"
else
  log_err "Build failed"
  exit 1
fi

# Step 2: Deploy to each cluster
echo "[2/4] Deploying to clusters..."
for ctx in "${CLUSTERS[@]}"; do
  echo "  → $ctx..."
  switch_context "$ctx"

  # Ensure namespace exists
  oc get namespace "$NAMESPACE" &>/dev/null 2>&1 || oc new-project "$NAMESPACE" 2>/dev/null || kubectl create namespace "$NAMESPACE" 2>/dev/null || true

  # Apply manifests
  oc apply -f "$DEPLOY_DIR/deployment.yaml" -n "$NAMESPACE"
  oc apply -f "$DEPLOY_DIR/route.yaml" -n "$NAMESPACE" 2>/dev/null || true

  # Update image
  oc set image deployment/tcs-agentic-ai mcp-server="$IMAGE" -n "$NAMESPACE"

  log_ok "$ctx manifests applied"
done

# Step 3: Wait for rollouts
echo "[3/4] Waiting for rollouts..."
FAILED=()
for ctx in "${CLUSTERS[@]}"; do
  switch_context "$ctx"
  if oc rollout status deployment/tcs-agentic-ai -n "$NAMESPACE" --timeout=180s 2>/dev/null; then
    log_ok "$ctx rollout complete"
  else
    log_err "$ctx rollout FAILED"
    FAILED+=("$ctx")
  fi
done

# Step 4: Health checks
echo "[4/4] Health verification..."
for ctx in "${CLUSTERS[@]}"; do
  switch_context "$ctx"
  ROUTE=$(oc get route tcs-agentic-ai -n "$NAMESPACE" -o jsonpath='{.spec.host}' 2>/dev/null || echo "")
  if [ -n "$ROUTE" ]; then
    STATUS=$(curl -sk -o /dev/null -w "%{http_code}" "https://$ROUTE/api/health" 2>/dev/null || echo "000")
    if [ "$STATUS" = "200" ]; then
      log_ok "$ctx healthy — https://$ROUTE"
    else
      log_warn "$ctx HTTP $STATUS — https://$ROUTE"
    fi
  else
    log_warn "$ctx no route found"
  fi
done

echo ""
if [ ${#FAILED[@]} -gt 0 ]; then
  echo -e "${RED}=== Deployment completed with errors ===${NC}"
  echo "Failed clusters: ${FAILED[*]}"
  echo "To rollback: ./deploy/deploy-all.sh --rollback"
  exit 1
else
  echo -e "${GREEN}=== Deployment successful ===${NC}"
fi
