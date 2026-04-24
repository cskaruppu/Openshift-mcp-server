#!/bin/bash
# Deploy the MCP AI Assistant to OpenShift.
# Usage: ./deploy.sh [namespace] [--with-proxy]
#
# Options:
#   --with-proxy   Deploy an egress proxy for clusters where pods can't
#                  reach external endpoints (Azure OpenAI, etc.) directly.

set -euo pipefail

NS="${1:-openshift-mcp}"
WITH_PROXY=false
for arg in "$@"; do
  [[ "$arg" == "--with-proxy" ]] && WITH_PROXY=true
done

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

# 4. Egress proxy (optional — for clusters with restricted pod egress)
if $WITH_PROXY; then
  echo "--- Deploying egress proxy (hostNetwork)..."
  oc apply -f "$K8S_DIR/egress-proxy.yaml"
  echo "    Waiting for proxy to be ready..."
  oc rollout status deployment/mcp-egress-proxy -n "$NS" --timeout=60s || true
  PROXY_IP=$(oc get svc mcp-egress-proxy -n "$NS" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo "")
  if [ -n "$PROXY_IP" ]; then
    PROXY_URL="http://${PROXY_IP}:3128"
    echo "    Egress proxy: $PROXY_URL"
  fi
fi

# 5. MCP server — deploy service first so we can get the ClusterIP
echo "--- Applying MCP server deployment and service..."
oc apply -f "$K8S_DIR/service.yaml"
oc apply -f "$K8S_DIR/deployment.yaml"

# 6. Set HTTPS_PROXY if egress proxy is deployed
if $WITH_PROXY && [ -n "${PROXY_URL:-}" ]; then
  echo "--- Setting HTTPS_PROXY=${PROXY_URL} on mcp-server..."
  oc set env deployment/mcp-server "HTTPS_PROXY=${PROXY_URL}" -n "$NS"
fi

# 7. Get the mcp-server Service ClusterIP (bypasses pod DNS issues)
echo "--- Resolving mcp-server ClusterIP..."
MCP_CLUSTER_IP=$(oc get svc mcp-server -n "$NS" -o jsonpath='{.spec.clusterIP}')
echo "    mcp-server ClusterIP: $MCP_CLUSTER_IP"

# 8. Patch the dashboard deployment with the real ClusterIP
echo "--- Patching dashboard backend to ${MCP_CLUSTER_IP}:3000..."
sed "s/MCP_SERVER_CLUSTER_IP/${MCP_CLUSTER_IP}/g" "$K8S_DIR/dashboard-deployment.yaml" | oc apply -f -

# 9. Dashboard — load HTML from file
echo "--- Loading dashboard HTML into ConfigMap..."
oc create configmap mcp-dashboard \
  --from-file=index.html="$SCRIPT_DIR/dashboard/index.html" \
  -n "$NS" \
  --dry-run=client -o yaml | oc apply -f -

# 10. Restart to pick up latest config
echo "--- Rolling out deployments..."
oc rollout restart deployment/mcp-server -n "$NS"
oc rollout restart deployment/mcp-dashboard -n "$NS"

echo ""
echo "==> Waiting for rollouts..."
oc rollout status deployment/mcp-server -n "$NS" --timeout=120s
oc rollout status deployment/mcp-dashboard -n "$NS" --timeout=120s

echo ""
echo "==> Deployment complete!"
ROUTE=$(oc get route mcp-dashboard -n "$NS" -o jsonpath='{.spec.host}' 2>/dev/null || echo "")
if [ -n "$ROUTE" ]; then
  echo "    Dashboard: https://$ROUTE"
fi
