#!/usr/bin/env bash
# ============================================================================
# TCS Agentic AI — MANAGEMENT BUNDLE deployment (deploy once, on one cluster)
# ============================================================================
#
# Deploys the complete management plane as ONE unit:
#
#   ┌────────────── Management Bundle ───────────────┐
#   │  Dashboard (React + nginx)    — stateless UI   │
#   │  Control Plane (MCP_MODE=control) — API + auth │
#   │  PostgreSQL (StatefulSet PVC) — all state      │
#   │  Redis                        — LLM reply cache│
#   └────────────────────────────────────────────────┘
#
# Every dashboard change (settings, chats, audit, incidents, KB, rules) is
# stored in PostgreSQL. The bundle is deployed ONCE and is NOT touched when
# MCP servers are refreshed — its data lives on PersistentVolumeClaims.
#
# The MCP server (the per-cluster data plane) is deployed separately with
# ./deploy/mcp/deploy.sh on EVERY cluster — including this one. This follows
# the ACM/Rancher pattern where the hub registers itself as a managed cluster.
#
# Prerequisites:
#   - oc (OpenShift) or kubectl logged in to the management cluster
#   - podman or docker available for image builds
#   - quay.io login configured (podman login quay.io)
#
# Usage:
#   ./deploy/dashboard/deploy.sh              # Full deploy (build + push + apply)
#   ./deploy/dashboard/deploy.sh --no-build   # Apply manifests only (images already pushed)
#   ./deploy/dashboard/deploy.sh --no-pull    # Skip git pull
#   -n custom-namespace                       # Custom namespace (default: openshift-mcp)
#   ./deploy/dashboard/deploy.sh --status     # Check current deployment status
#   ./deploy/dashboard/deploy.sh --rollback   # Rollback to previous revision
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
DASHBOARD_IMAGE="${DASHBOARD_IMAGE:-quay.io/karuppucs/mcp-dashboard:latest}"
BUILD=true
GIT_PULL=true
ACTION="deploy"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
K8S_DIR="$SCRIPT_DIR/manifests"

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
    oc get route mcp-dashboard -n "$NS" -o jsonpath='https://{.spec.host}' 2>/dev/null || echo ""
  else
    kubectl get ingress mcp-dashboard -n "$NS" -o jsonpath='https://{.spec.rules[0].host}' 2>/dev/null || echo ""
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
  echo " TCS Agentic AI — Management Bundle Status"
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
  echo " TCS Agentic AI — Management Bundle Rollback"
  echo " Namespace: $NS"
  echo "============================================"
  echo ""
  echo "Rolling back control plane..."
  $CLI rollout undo deployment/agentic-ai-server -n "$NS"
  echo "Rolling back dashboard..."
  $CLI rollout undo deployment/agentic-ai-dashboard -n "$NS"
  echo "Waiting for rollout..."
  $CLI rollout status deployment/agentic-ai-server -n "$NS" --timeout=120s
  $CLI rollout status deployment/agentic-ai-dashboard -n "$NS" --timeout=120s
  echo ""
  echo "Rollback complete."
  $CLI get pods -n "$NS" -o wide
  exit 0
fi

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------
STEPS=10

echo "============================================"
echo " TCS Agentic AI — Management Bundle"
echo "============================================"
echo " Namespace       : $NS"
echo " MCP Server Image: $MCP_IMAGE"
echo " Dashboard Image : $DASHBOARD_IMAGE"
echo " Build           : $BUILD"
echo " CLI             : $CLI"
echo " Runtime         : ${RUNTIME:-'(none — build disabled)'}"
echo ""
echo " Components (deployed once, persisted on PVCs):"
echo "   [1] Control Plane — API + auth + federation routing (stateless)"
echo "   [2] Dashboard     — React + Nginx (stateless UI)"
echo "   [3] PostgreSQL    — all state (StatefulSet PVC)"
echo "   [4] Redis         — LLM reply cache"
echo ""
echo " The per-cluster MCP server is deployed separately:"
echo "   ./deploy/mcp/deploy.sh   (run on EVERY cluster, incl. this one)"
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

  # Remove stale image tags from prior naming schemes (avoids confusing double-tag output)
  $RUNTIME rmi quay.io/karuppucs/agentic-ai-server:latest 2>/dev/null || true
  $RUNTIME rmi quay.io/karuppucs/tcs-agentic-dashboard:latest 2>/dev/null || true

  # BUILD_HASH is baked into the image and used for: (a) chat cache
  # invalidation on redeploy, (b) image-drift detection across clusters
  # ("Update Available" badge). Unique per commit; a time suffix is added
  # when the working tree has uncommitted changes so rebuilds still differ.
  BUILD_HASH=$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    BUILD_HASH="${BUILD_HASH}-$(date +%H%M%S)"
  fi
  echo "  [a] Building MCP server image (BUILD_HASH=$BUILD_HASH)..."
  $RUNTIME build --build-arg BUILD_HASH="$BUILD_HASH" -t "$MCP_IMAGE" -f Dockerfile .
  echo "  [b] Building Dashboard image..."
  $RUNTIME build -t "$DASHBOARD_IMAGE" -f console/Dockerfile console/

  echo "  Pushing images..."
  push_with_retry "$MCP_IMAGE"
  push_with_retry "$DASHBOARD_IMAGE"
else
  echo "  Skipped (--no-build)"
fi

# 3. Namespace and RBAC
next "Applying namespace, service account, RBAC..."
$CLI apply -f "$K8S_DIR/namespace.yaml"

# Clean up retired resources. NOTE: the "mcp-server" name family now belongs
# to the per-cluster MCP server (./deploy/mcp/deploy.sh) and must NOT be
# deleted here — the bundle never touches the data plane.
echo "  Removing retired resources (if any)..."
$CLI delete deployment tcs-dashboard -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete service tcs-dashboard -n "$NS" --ignore-not-found 2>/dev/null || true
# Retired bundled hub-agent — replaced by running ./deploy/mcp/deploy.sh on
# this cluster like any other (registers as "hub-cluster").
$CLI delete deployment mcp-hub-agent -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete service mcp-hub-agent -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete configmap mcp-hub-agent-config -n "$NS" --ignore-not-found 2>/dev/null || true
# Old deployment names (renamed to the agentic-ai-* family). Services, the
# Route, and the postgres StatefulSet keep their stable names.
$CLI delete deployment mcp-dashboard -n "$NS" --ignore-not-found 2>/dev/null || true
$CLI delete deployment mcp-redis -n "$NS" --ignore-not-found 2>/dev/null || true
# Old unused dashboard PVC (the dashboard is stateless; state is in PostgreSQL)
$CLI delete pvc mcp-dashboard-data -n "$NS" --ignore-not-found 2>/dev/null || true

if [ "$NS" != "openshift-mcp" ]; then
  echo "  (Patching manifests for namespace: $NS)"
  for f in "$K8S_DIR"/*.yaml; do
    sed -i "s/namespace: openshift-mcp/namespace: $NS/g" "$f"
  done
fi
$CLI apply -f "$K8S_DIR/serviceaccount.yaml"

# 4. Secrets and config
next "Applying secrets, configmap, network policy..."

# Auto-generate a real API token if the secret still has the CHANGEME placeholder
EXISTING_TOKEN=$($CLI get secret agentic-ai-server-secrets -n "$NS" -o jsonpath='{.data.MCP_API_TOKEN}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
if [ -z "$EXISTING_TOKEN" ] || [ "$EXISTING_TOKEN" = "CHANGEME" ]; then
  GENERATED_TOKEN=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 64)
  echo "  Generating secure API token (MCP_API_TOKEN)..."
  # Apply the base secret first, then patch with the generated token
  $CLI apply -f "$K8S_DIR/secret.yaml"
  $CLI patch secret agentic-ai-server-secrets -n "$NS" --type merge \
    -p "{\"stringData\":{\"MCP_API_TOKEN\":\"$GENERATED_TOKEN\",\"MCP_ADMIN_PASSWORD\":\"$GENERATED_TOKEN\"}}"
  echo "  ✓ API token generated and stored in secret"
else
  echo "  Using existing API token from secret"
  $CLI apply -f "$K8S_DIR/secret.yaml"
  # Restore the real token (apply may have overwritten it with CHANGEME from the manifest)
  $CLI patch secret agentic-ai-server-secrets -n "$NS" --type merge \
    -p "{\"stringData\":{\"MCP_API_TOKEN\":\"$EXISTING_TOKEN\"}}"
fi
$CLI apply -f "$K8S_DIR/configmap.yaml"
$CLI apply -f "$K8S_DIR/networkpolicy.yaml" 2>/dev/null || true

# 5. DNS forwarding for spoke cluster hostnames
next "Configuring DNS forwarding for spoke clusters..."
# Extract SPOKE_DNS_SERVER from configmap (hardcoded 10.131.19.154 for caaslab)
SPOKE_DNS=$($CLI get configmap agentic-ai-server-config -n "$NS" -o jsonpath='{.data.SPOKE_DNS_SERVER}' 2>/dev/null || echo "")
if [ "$CLI" = "oc" ] && [ -n "$SPOKE_DNS" ]; then
  # Add DNS Operator forwarding rules for spoke zones so CoreDNS can resolve
  # spoke Route hostnames (e.g. *.apps.ocp.caaslab.local) via the custom DNS.
  echo "  Adding DNS forwarding rules for spoke zones → $SPOKE_DNS"
  # Check current forwarding config
  EXISTING_FWD=$(oc get dns.operator/default -o jsonpath='{.spec.servers}' 2>/dev/null || echo "")
  if echo "$EXISTING_FWD" | grep -q "$SPOKE_DNS" 2>/dev/null; then
    echo "  DNS forwarding already configured for $SPOKE_DNS — skipping"
  else
    oc patch dns.operator/default --type=merge -p "$(cat <<DNSPATCH
{
  "spec": {
    "servers": [
      {
        "name": "spoke-caaslab-dns",
        "zones": ["ocp.caaslab.local"],
        "forwardPlugin": {
          "upstreams": ["$SPOKE_DNS"],
          "policy": "Random"
        }
      }
    ]
  }
}
DNSPATCH
)" 2>/dev/null && echo "  ✓ DNS Operator forwarding configured" || echo "  ⚠  DNS Operator patch skipped (may need admin privileges)"
  fi
else
  echo "  Skipped (not OpenShift or no SPOKE_DNS_SERVER configured)"
fi

# 6. Persistent storage and data stores
next "Deploying PostgreSQL and Redis..."
# Persistence lives here: PostgreSQL's StatefulSet volumeClaimTemplate.
# Dashboard and MCP server pods are stateless and carry no PVC.
$CLI apply -f "$K8S_DIR/postgres.yaml" 2>&1 | grep -v "is invalid" || true
$CLI apply -f "$K8S_DIR/redis.yaml" 2>&1 | grep -v "is invalid" || true

# 7. Control Plane deployment (MCP_MODE=control — global routes, persistence,
#    federation routing only; data-plane queries are delegated to the MCP
#    server pods registered from each cluster)
next "Deploying Control Plane (MCP_MODE=control)..."
sed -i "s|image:.*openshift-mcp-server:.*|image: ${MCP_IMAGE}|" "$K8S_DIR/deployment.yaml"
$CLI apply -f "$K8S_DIR/deployment.yaml"
$CLI apply -f "$K8S_DIR/service.yaml"
$CLI set image deployment/agentic-ai-server agentic-ai-server="$MCP_IMAGE" -n "$NS" 2>/dev/null || true
# Control plane is internal-only — remove any legacy external route from prior deploys.
if [ "$CLI" = "oc" ]; then
  oc delete route agentic-ai-server -n "$NS" --ignore-not-found 2>/dev/null || true
fi

# 8. Dashboard deployment (separate pod — React + Nginx, stateless)
#    Applies deploy/dashboard/manifests/dashboard-deployment.yaml, which carries the
#    PersistentVolumeClaim (persistence) + OpenShift-safe volume mounts
#    (/tmp, /var/cache/nginx, /var/run) so Nginx runs under a random UID.
next "Deploying Dashboard (React + Nginx)..."
sed -i "s|image:.*mcp-dashboard:.*|image: ${DASHBOARD_IMAGE}|" "$K8S_DIR/dashboard-deployment.yaml"
if [ "$CLI" = "oc" ]; then
  $CLI apply -f "$K8S_DIR/dashboard-deployment.yaml"
else
  # Non-OpenShift: apply everything except the Route (Ingress would be set up separately)
  $CLI apply -f "$K8S_DIR/dashboard-deployment.yaml" 2>&1 | grep -v 'route.openshift.io' || true
fi
$CLI set image deployment/agentic-ai-dashboard dashboard="$DASHBOARD_IMAGE" -n "$NS" 2>/dev/null || true

# 9. Rollout and verify
next "Rolling out and verifying..."
$CLI rollout restart deployment/agentic-ai-server -n "$NS"
$CLI rollout restart deployment/agentic-ai-dashboard -n "$NS"
echo "  Waiting for Control Plane..."
$CLI rollout status deployment/agentic-ai-server -n "$NS" --timeout=180s
echo "  Waiting for Dashboard..."
$CLI rollout status deployment/agentic-ai-dashboard -n "$NS" --timeout=120s

echo ""
echo "--- Pod Status ---"
$CLI get pods -n "$NS" -o wide
echo ""

URL=$(hub_url)

# 10. Summary
next "Deployment complete!"

echo ""
echo "============================================"
echo " Management Bundle deployment complete!"
echo "============================================"
echo ""
echo " Deployed (once — MCP server refreshes never touch this bundle):"
echo "   ✓ Control Plane : $MCP_IMAGE${BUILD_HASH:+ (build $BUILD_HASH)}"
echo "   ✓ Dashboard     : $DASHBOARD_IMAGE"
echo "   ✓ PostgreSQL    : all state — settings, chats, audit, incidents, KB (PVC)"
echo "   ✓ Redis         : LLM reply cache"
echo ""
if [ -n "$URL" ]; then
  echo " Dashboard     : $URL"
  echo " API (via nginx): $URL/api/"
  echo " MCP (SSE)     : $URL/sse"
  echo " Health        : $URL/nginx-health"
  echo " Spoke Status  : $URL/api/spoke/status"
else
  echo " No route/ingress found."
  echo " Access via: $CLI port-forward svc/mcp-dashboard 8080:8080 -n $NS"
fi
echo ""
echo " Commit: $(git -C "$REPO_ROOT" log --oneline -1 2>/dev/null || echo 'N/A')"
echo ""

# Extract hub token for the spoke deploy command
HUB_TOKEN=$($CLI get secret agentic-ai-server-secrets -n "$NS" -o jsonpath='{.data.MCP_API_TOKEN}' 2>/dev/null | base64 -d 2>/dev/null || echo "")

echo " ─────────────────────────────────────────"
echo " NEXT STEP — Deploy the MCP server on EVERY cluster (incl. this one):"
echo " ─────────────────────────────────────────"
echo ""
if [ -n "$HUB_TOKEN" ] && [ "$HUB_TOKEN" != "CHANGEME" ]; then
  echo " [1] On THIS cluster (registers as the management cluster's data plane):"
  echo ""
  echo "   ./deploy/mcp/deploy.sh \\"
  echo "     --hub-url $URL \\"
  echo "     --hub-token $HUB_TOKEN \\"
  echo "     --cluster-name hub-cluster \\"
  echo "     --platform openshift \\"
  echo "     --tls-skip"
  echo ""
  echo " [2] On each ADDITIONAL cluster (replace <CLUSTER_NAME>, e.g. prod-east):"
  echo ""
  echo "   ./deploy/mcp/deploy.sh \\"
  echo "     --hub-url $URL \\"
  echo "     --hub-token $HUB_TOKEN \\"
  echo "     --cluster-name <CLUSTER_NAME> \\"
  echo "     --platform openshift \\"
  echo "     --tls-skip"
  echo ""
  echo " Code updates later: just click ⋮ → Redeploy on the cluster card —"
  echo " no need to rerun any script. This bundle stays untouched."
  echo ""
  echo " Hub API Token: $HUB_TOKEN"
else
  echo " ⚠  Hub token could not be retrieved. Set it manually:"
  echo "   $CLI -n $NS create secret generic agentic-ai-server-secrets \\"
  echo "     --from-literal=MCP_API_TOKEN=\$(openssl rand -hex 32) --dry-run=client -o yaml | $CLI apply -f -"
  echo "   Then re-run this script."
fi
echo ""
echo "============================================"
