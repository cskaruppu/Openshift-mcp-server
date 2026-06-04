#!/usr/bin/env bash
# ============================================================================
# TCS Agentic AI — Unified Build & Deploy Pipeline
# ============================================================================
#
# Builds hub server and/or agent images, pushes to Quay.io, and
# automatically triggers rolling deployments on all clusters.
#
# Usage:
#   ./build.sh                    # Build + push both images, auto-deploy all
#   ./build.sh hub                # Build + push hub only, deploy hub
#   ./build.sh agent              # Build + push agent only, deploy agents
#   ./build.sh --no-deploy        # Build + push only, skip deployment
#   ./build.sh --no-push          # Build only, skip push and deploy
#   ./build.sh --no-pull          # Skip git pull, build from local files
#   ./build.sh --no-ui            # Skip host-side React dashboard build
#   ./build.sh --tag v1.1.0       # Tag images with version + latest
#   ./build.sh agent --tag v1.1.0 --no-deploy   # Tag agent, skip deploy
#
# Environment:
#   BUILD_BRANCH    Git branch to pull (default: claude/setup-mcp-openshift-9JUo7)
#   HUB_URL         Hub server URL for agent rollout (default: auto-detect from route)
#   QUAY_REGISTRY   Registry prefix (default: quay.io/karuppucs)
#   HUB_NAMESPACE   Hub deployment namespace (default: openshift-mcp)
#
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
REGISTRY="${QUAY_REGISTRY:-quay.io/karuppucs}"
HUB_IMAGE_NAME="openshift-mcp-server"
AGENT_IMAGE_NAME="tcs-agentic-ai"
BRANCH="${BUILD_BRANCH:-claude/setup-mcp-openshift-9JUo7}"
HUB_NS="${HUB_NAMESPACE:-openshift-mcp}"

# Defaults
TARGET="all"          # all | hub | agent
TAG="latest"
PULL=true
PUSH=true
DEPLOY=true
BUILD_UI=true         # build the Phase 2 React dashboard on the host

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    hub|agent|all)     TARGET="$1"; shift ;;
    --tag)             TAG="$2"; shift 2 ;;
    --no-pull)         PULL=false; shift ;;
    --no-ui)           BUILD_UI=false; shift ;;
    --no-push)         PUSH=false; DEPLOY=false; shift ;;
    --no-deploy)       DEPLOY=false; shift ;;
    --pull)            PULL=true; shift ;;
    --push)            PUSH=true; shift ;;
    --deploy)          DEPLOY=true; shift ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown option: $1. Use --help for usage."; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HUB_FULL="${REGISTRY}/${HUB_IMAGE_NAME}"
AGENT_FULL="${REGISTRY}/${AGENT_IMAGE_NAME}"

# ---------------------------------------------------------------------------
# Detect container runtime
# ---------------------------------------------------------------------------
if command -v podman &>/dev/null; then
  RUNTIME="podman"
elif command -v docker &>/dev/null; then
  RUNTIME="docker"
else
  echo "ERROR: Neither podman nor docker found."
  exit 1
fi

# Detect cluster CLI
if command -v oc &>/dev/null; then
  KUBE="oc"
elif command -v kubectl &>/dev/null; then
  KUBE="kubectl"
else
  KUBE=""
fi

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
echo ""
echo "  ============================================"
echo "   TCS Agentic AI — Build & Deploy Pipeline"
echo "  ============================================"
echo ""
echo "  Target     : ${TARGET}"
echo "  Tag        : ${TAG}"
echo "  Registry   : ${REGISTRY}"
echo "  Branch     : ${BRANCH}"
echo "  Git pull   : ${PULL}"
echo "  Build UI   : ${BUILD_UI}"
echo "  Push       : ${PUSH}"
echo "  Auto-deploy: ${DEPLOY}"
echo "  Runtime    : ${RUNTIME}"
echo "  Kube CLI   : ${KUBE:-none}"
echo ""

TOTAL=0
BUILT=0
PUSHED=0
DEPLOYED=0

# ---------------------------------------------------------------------------
# Step 1: Pull latest code
# ---------------------------------------------------------------------------
if [ "$PULL" = true ]; then
  echo "--- [1] Pulling latest code ---"
  cd "$SCRIPT_DIR"
  if [ -d .git ]; then
    CURRENT=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    if [ "$CURRENT" != "$BRANCH" ]; then
      echo "  Switching from ${CURRENT} to ${BRANCH}..."
      git fetch origin "${BRANCH}"
      git checkout "${BRANCH}" 2>/dev/null || git checkout -b "${BRANCH}" "origin/${BRANCH}"
    fi
    git fetch origin "${BRANCH}"
    git reset --hard "origin/${BRANCH}"
    echo "  Commit: $(git log --oneline -1)"
  else
    echo "  WARNING: Not a git repo. Building from local files."
  fi
  echo ""
else
  echo "--- [1] Skipping git pull (--no-pull) ---"
  echo ""
fi

# ---------------------------------------------------------------------------
# Step 2: Build images
# ---------------------------------------------------------------------------
build_image() {
  local name="$1"
  local full="$2"
  local dockerfile="$3"
  local context="$4"

  echo "--- Building ${name} image ---"
  echo "  Dockerfile : ${dockerfile}"
  echo "  Context    : ${context}"

  ${RUNTIME} build -t "${full}:${TAG}" -f "${dockerfile}" "${context}"

  if [ "${TAG}" != "latest" ]; then
    ${RUNTIME} tag "${full}:${TAG}" "${full}:latest"
  fi

  echo "  Built: ${full}:${TAG}"
  ${RUNTIME} images "${full}" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}" 2>/dev/null || true
  echo ""
  BUILT=$((BUILT + 1))
}

# ---------------------------------------------------------------------------
# Step 1.5: Build the Phase 2 React dashboard (host-side)
# Produces dashboard/next/, which the hub Dockerfile copies into the image.
# The Dockerfile ALSO builds the UI inside the image (stage "ui-build"), so this
# host step is an optimization / keeps the committed output fresh — it is
# non-fatal if Node/npm is unavailable on the build host.
# ---------------------------------------------------------------------------
build_dashboard_ui() {
  local ui_dir="${SCRIPT_DIR}/dashboard-react"
  if [ ! -d "$ui_dir" ]; then
    echo "  dashboard-react/ not found — skipping UI build."
    return 0
  fi
  if ! command -v npm &>/dev/null; then
    echo "  npm not found on host — the Dockerfile will build the UI inside the image."
    return 0
  fi
  echo "  Building React dashboard (dashboard-react -> dashboard/next)..."
  (
    cd "$ui_dir"
    if [ ! -d node_modules ]; then
      npm ci 2>&1 | tail -3
    fi
    npm run build 2>&1 | tail -5
  ) || {
    echo "  WARNING: Host UI build failed — the Dockerfile will rebuild it inside the image."
    return 0
  }
  echo "  React dashboard built: dashboard/next/"
}

if [ "$BUILD_UI" = true ] && { [ "$TARGET" = "all" ] || [ "$TARGET" = "hub" ]; }; then
  echo "--- [1.5] Building React dashboard (Phase 2 UI) ---"
  build_dashboard_ui
  echo ""
else
  echo "--- [1.5] Skipping host UI build ---"
  echo ""
fi

echo "--- [2] Building container images ---"
echo ""

if [ "$TARGET" = "all" ] || [ "$TARGET" = "hub" ]; then
  build_image "Hub Server" "${HUB_FULL}" "${SCRIPT_DIR}/Dockerfile" "${SCRIPT_DIR}"
fi

if [ "$TARGET" = "all" ] || [ "$TARGET" = "agent" ]; then
  build_image "Agent" "${AGENT_FULL}" "${SCRIPT_DIR}/agent/Dockerfile" "${SCRIPT_DIR}/agent"
fi

TOTAL=$BUILT

# ---------------------------------------------------------------------------
# Step 3: Push to registry
# ---------------------------------------------------------------------------
push_image() {
  local name="$1"
  local full="$2"

  echo "  Pushing ${name}: ${full}:${TAG}..."

  local attempt=0
  local max_retries=4
  local delay=2

  while [ $attempt -lt $max_retries ]; do
    if ${RUNTIME} push "${full}:${TAG}" 2>&1; then
      if [ "${TAG}" != "latest" ]; then
        ${RUNTIME} push "${full}:latest" 2>&1 || true
      fi
      PUSHED=$((PUSHED + 1))
      echo "  Pushed: ${full}:${TAG}"
      return 0
    fi

    attempt=$((attempt + 1))
    if [ $attempt -lt $max_retries ]; then
      echo "  Push failed (attempt ${attempt}/${max_retries}). Retrying in ${delay}s..."
      sleep $delay
      delay=$((delay * 2))
    fi
  done

  echo "  ERROR: Push failed after ${max_retries} attempts."
  return 1
}

if [ "$PUSH" = true ]; then
  echo "--- [3] Pushing images to ${REGISTRY} ---"
  echo "  (Ensure you are logged in: ${RUNTIME} login quay.io)"
  echo ""

  if [ "$TARGET" = "all" ] || [ "$TARGET" = "hub" ]; then
    push_image "Hub Server" "${HUB_FULL}"
  fi

  if [ "$TARGET" = "all" ] || [ "$TARGET" = "agent" ]; then
    push_image "Agent" "${AGENT_FULL}"
  fi

  echo ""
else
  echo "--- [3] Skipping push (--no-push) ---"
  echo ""
fi

# ---------------------------------------------------------------------------
# Step 4: Auto-deploy
# ---------------------------------------------------------------------------
deploy_hub() {
  echo "  Deploying hub server on local cluster..."

  if [ -z "$KUBE" ]; then
    echo "  WARNING: No kubectl/oc found. Skipping hub deployment."
    return 1
  fi

  # Rollout restart the hub deployment
  ${KUBE} rollout restart deployment/mcp-server -n "${HUB_NS}" 2>/dev/null || {
    echo "  WARNING: Could not restart hub deployment. Is it running?"
    return 1
  }

  echo "  Waiting for hub rollout..."
  ${KUBE} rollout status deployment/mcp-server -n "${HUB_NS}" --timeout=180s 2>/dev/null || {
    echo "  WARNING: Hub rollout timed out. Check pod status manually."
    return 1
  }

  echo "  Hub server deployed successfully."
  DEPLOYED=$((DEPLOYED + 1))

  # Show status
  echo ""
  echo "  --- Hub Pod Status ---"
  ${KUBE} get pods -n "${HUB_NS}" -l app.kubernetes.io/name=openshift-mcp-server -o wide 2>/dev/null || true
  return 0
}

deploy_agents() {
  echo "  Deploying agents on remote clusters..."

  # Detect hub URL from route or env
  local hub_url="${HUB_URL:-}"
  if [ -z "$hub_url" ] && [ -n "$KUBE" ]; then
    hub_url=$( ${KUBE} get route mcp-server -n "${HUB_NS}" -o jsonpath='https://{.spec.host}' 2>/dev/null || echo "" )
  fi

  if [ -z "$hub_url" ]; then
    echo "  WARNING: Cannot detect hub URL. Set HUB_URL env var."
    echo "  Agents will pick up the new image on their next restart."
    return 1
  fi

  echo "  Hub URL: ${hub_url}"
  echo "  Sending rollout-restart to all connected agents..."

  local resp
  resp=$(curl -s -X POST "${hub_url}/api/agent/rollout-restart" \
    -H "Content-Type: application/json" \
    -d '{}' \
    --connect-timeout 10 \
    --max-time 15 2>/dev/null || echo '{"error":"connection failed"}')

  local notified
  notified=$(echo "$resp" | grep -o '"agentsNotified":[0-9]*' | cut -d: -f2 || echo "0")

  if [ "${notified:-0}" -gt 0 ]; then
    echo "  Rollout restart sent to ${notified} agent(s)."
    echo "  Agents will pull the latest image and restart automatically."
    DEPLOYED=$((DEPLOYED + notified))
  else
    echo "  No agents currently connected via SSE bridge."
    echo "  Agents will pick up the new image on their next pod restart."
  fi

  return 0
}

if [ "$DEPLOY" = true ] && [ "$PUSH" = true ]; then
  echo "--- [4] Auto-deploying ---"
  echo ""

  if [ "$TARGET" = "all" ] || [ "$TARGET" = "hub" ]; then
    deploy_hub
    echo ""
  fi

  if [ "$TARGET" = "all" ] || [ "$TARGET" = "agent" ]; then
    deploy_agents
    echo ""
  fi
else
  echo "--- [4] Skipping deployment ---"
  echo ""
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "  ============================================"
echo "   Build & Deploy Complete"
echo "  ============================================"
echo ""
echo "  Images built  : ${BUILT}"
echo "  Images pushed  : ${PUSHED}"
echo "  Deployments    : ${DEPLOYED}"
echo "  Commit         : $(git log --oneline -1 2>/dev/null || echo 'N/A')"

if [ "$TARGET" = "all" ] || [ "$TARGET" = "hub" ]; then
  echo ""
  echo "  Hub image  : ${HUB_FULL}:${TAG}"
fi
if [ "$TARGET" = "all" ] || [ "$TARGET" = "agent" ]; then
  echo "  Agent image: ${AGENT_FULL}:${TAG}"
fi

if [ -n "$KUBE" ]; then
  ROUTE=$( ${KUBE} get route mcp-server -n "${HUB_NS}" -o jsonpath='{.spec.host}' 2>/dev/null || echo "" )
  if [ -n "$ROUTE" ]; then
    echo ""
    echo "  Dashboard : https://${ROUTE}"
  fi
fi

echo ""
echo "  ============================================"
