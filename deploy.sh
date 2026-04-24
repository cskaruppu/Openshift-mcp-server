#!/bin/bash
# Deploy the MCP AI Assistant to OpenShift.
# Usage: ./deploy.sh [namespace]

set -euo pipefail

NS="${1:-openshift-mcp}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
K8S_DIR="$SCRIPT_DIR/k8s"

echo "==> Deploying to namespace: $NS"

# 1. Namespace & ServiceAccount
echo "--- Applying namespace, service account, secrets, configmap..."
oc apply -f "$K8S_DIR/namespace.yaml"
oc apply -f "$K8S_DIR/serviceaccount.yaml"
oc apply -f "$K8S_DIR/secret.yaml"
oc apply -f "$K8S_DIR/configmap.yaml"

# 2. Network policy
echo "--- Applying network policies..."
oc apply -f "$K8S_DIR/networkpolicy.yaml"

# 3. Data stores
echo "--- Applying Postgres and Redis..."
oc apply -f "$K8S_DIR/postgres.yaml"
oc apply -f "$K8S_DIR/redis.yaml"

# 4. MCP server (serves both API and dashboard HTML)
echo "--- Applying MCP server deployment and service..."
oc apply -f "$K8S_DIR/service.yaml"
oc apply -f "$K8S_DIR/deployment.yaml"

# 5. Restart to pick up latest config
echo "--- Rolling out deployment..."
oc rollout restart deployment/mcp-server -n "$NS"

echo ""
echo "==> Waiting for rollout..."
oc rollout status deployment/mcp-server -n "$NS" --timeout=120s

echo ""
echo "==> Deployment complete!"
ROUTE=$(oc get route mcp-server -n "$NS" -o jsonpath='{.spec.host}' 2>/dev/null || echo "")
if [ -n "$ROUTE" ]; then
  echo "    Dashboard: https://$ROUTE"
fi
