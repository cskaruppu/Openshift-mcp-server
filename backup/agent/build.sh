#!/usr/bin/env bash
#
# Build and push the TCS Agentic AI Agent image to quay.io
#
# Usage:
#   ./build.sh                   # pull latest, build, push, auto-deploy agents
#   ./build.sh v1.1.0            # build with tag v1.1.0 + latest
#   ./build.sh --no-pull         # build from local files
#   ./build.sh --no-push         # build only, skip push to registry
#   ./build.sh --no-deploy       # build + push, skip auto-deploy
#   ./build.sh --clone           # clone fresh from GitHub into /tmp
#
# After push, the script calls the hub's rollout-restart API to
# trigger rolling updates on all connected remote agents automatically.
#
set -euo pipefail

REGISTRY="quay.io/karuppucs"
IMAGE_NAME="tcs-agentic-ai"
REPO_URL="https://github.com/cskaruppu/openshift-mcp-server.git"
BRANCH="${BUILD_BRANCH:-claude/setup-mcp-openshift-9JUo7}"
PULL=true
CLONE=false
PUSH=true
DEPLOY=true
TAG="latest"

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --pull)      PULL=true ;;
    --no-pull)   PULL=false ;;
    --clone)     CLONE=true ;;
    --no-push)   PUSH=false; DEPLOY=false ;;
    --no-deploy) DEPLOY=false ;;
    --deploy)    DEPLOY=true ;;
    -*)          echo "Unknown flag: $arg"; exit 1 ;;
    *)           TAG="$arg" ;;
  esac
done

FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}"

echo "============================================"
echo "  TCS Agentic AI — Agent Image Builder"
echo "============================================"
echo "Registry   : ${REGISTRY}"
echo "Image      : ${IMAGE_NAME}"
echo "Tag        : ${TAG}"
echo "Source     : ${REPO_URL}"
echo "Branch     : ${BRANCH}"
echo "Auto-deploy: ${DEPLOY}"
echo ""

# Detect container runtime
if command -v podman &>/dev/null; then
  RUNTIME="podman"
elif command -v docker &>/dev/null; then
  RUNTIME="docker"
else
  echo "ERROR: Neither podman nor docker found. Install one to build images."
  exit 1
fi
echo "Runtime    : ${RUNTIME}"
echo ""

# Determine build context directory
BUILD_DIR="$(cd "$(dirname "$0")" && pwd)"
CLEANUP_DIR=""

if [ "$CLONE" = true ]; then
  echo "[1/4] Cloning latest code from GitHub..."
  CLONE_DIR=$(mktemp -d)
  CLEANUP_DIR="$CLONE_DIR"
  git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${CLONE_DIR}" 2>&1
  BUILD_DIR="${CLONE_DIR}/agent"
  echo "  Cloned to: ${CLONE_DIR}"
  echo "  Commit: $(git -C "${CLONE_DIR}" log --oneline -1)"
  echo ""
elif [ "$PULL" = true ]; then
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  if [ -d "${REPO_ROOT}/.git" ]; then
    echo "[1/4] Pulling latest code from GitHub..."
    CURRENT=$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    if [ "$CURRENT" != "$BRANCH" ]; then
      echo "  Switching from ${CURRENT} to ${BRANCH}..."
      git -C "${REPO_ROOT}" fetch origin "${BRANCH}"
      git -C "${REPO_ROOT}" checkout "${BRANCH}" 2>/dev/null || \
        git -C "${REPO_ROOT}" checkout -b "${BRANCH}" "origin/${BRANCH}"
    fi
    git -C "${REPO_ROOT}" fetch origin "${BRANCH}"
    git -C "${REPO_ROOT}" reset --hard "origin/${BRANCH}"
    echo "  Updated to: $(git -C "${REPO_ROOT}" log --oneline -1)"
    echo ""
  else
    echo "ERROR: --pull requires running from within the git repo."
    echo "  Use --clone instead to build from a fresh checkout."
    exit 1
  fi
else
  echo "[1/4] Building from local files (--no-pull)."
  echo ""
fi

# Build
echo "[2/4] Building image from ${BUILD_DIR}..."
${RUNTIME} build -t "${FULL_IMAGE}:${TAG}" -f "${BUILD_DIR}/Dockerfile" "${BUILD_DIR}"

if [ "${TAG}" != "latest" ]; then
  ${RUNTIME} tag "${FULL_IMAGE}:${TAG}" "${FULL_IMAGE}:latest"
fi

echo ""
echo "  Image built:"
${RUNTIME} images "${FULL_IMAGE}" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}" 2>/dev/null || true

if [ "$PUSH" = true ]; then
  echo ""
  echo "[3/4] Pushing to ${REGISTRY}..."
  echo "  (Ensure login: ${RUNTIME} login quay.io)"
  echo ""

  ATTEMPT=0
  MAX_RETRIES=4
  DELAY=2

  while [ $ATTEMPT -lt $MAX_RETRIES ]; do
    if ${RUNTIME} push "${FULL_IMAGE}:${TAG}" 2>&1; then
      if [ "${TAG}" != "latest" ]; then
        ${RUNTIME} push "${FULL_IMAGE}:latest" 2>&1 || true
      fi
      echo "  Push complete: ${FULL_IMAGE}:${TAG}"
      break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    if [ $ATTEMPT -lt $MAX_RETRIES ]; then
      echo "  Push failed (attempt ${ATTEMPT}/${MAX_RETRIES}). Retrying in ${DELAY}s..."
      sleep $DELAY
      DELAY=$((DELAY * 2))
    else
      echo "  ERROR: Push failed after ${MAX_RETRIES} attempts."
      exit 1
    fi
  done
else
  echo ""
  echo "[3/4] Skipping push (--no-push). Image available locally:"
  echo "  ${FULL_IMAGE}:${TAG}"
fi

# Auto-deploy agents via hub API
if [ "$DEPLOY" = true ] && [ "$PUSH" = true ]; then
  echo ""
  echo "[4/4] Auto-deploying agents via hub..."

  # Detect hub URL
  HUB_URL="${HUB_URL:-}"
  if [ -z "$HUB_URL" ]; then
    if command -v oc &>/dev/null; then
      HUB_URL=$(oc get route agentic-ai-server -n openshift-mcp -o jsonpath='https://{.spec.host}' 2>/dev/null || echo "")
    fi
    if [ -z "$HUB_URL" ] && command -v kubectl &>/dev/null; then
      HUB_URL=$(kubectl get ingress agentic-ai-server -n openshift-mcp -o jsonpath='https://{.spec.rules[0].host}' 2>/dev/null || echo "")
    fi
  fi

  if [ -n "$HUB_URL" ]; then
    echo "  Hub URL: ${HUB_URL}"
    echo "  Sending rollout-restart to all agents..."
    RESP=$(curl -s -X POST "${HUB_URL}/api/agent/rollout-restart" \
      -H "Content-Type: application/json" \
      -d '{}' \
      --connect-timeout 10 \
      --max-time 15 2>/dev/null || echo '{"error":"failed"}')

    NOTIFIED=$(echo "$RESP" | grep -o '"agentsNotified":[0-9]*' | cut -d: -f2 || echo "0")
    if [ "${NOTIFIED:-0}" -gt 0 ]; then
      echo "  Rollout restart sent to ${NOTIFIED} agent(s)."
      echo "  Agents will pull ${FULL_IMAGE}:${TAG} and restart."
    else
      echo "  No agents connected via SSE bridge."
      echo "  Agents will pick up the new image on next pod restart."
    fi
  else
    echo "  WARNING: Cannot detect hub URL. Set HUB_URL env var."
    echo "  Agents will pick up the new image on next pod restart."
  fi
else
  echo ""
  echo "[4/4] Skipping auto-deploy."
fi

echo ""
echo "============================================"
echo "  Build complete!"
echo ""
echo "  Image : ${FULL_IMAGE}:${TAG}"
echo "  Commit: $(git log --oneline -1 2>/dev/null || echo 'N/A')"
echo "============================================"

# Cleanup temp clone if used
if [ -n "$CLEANUP_DIR" ] && [ -d "$CLEANUP_DIR" ]; then
  rm -rf "$CLEANUP_DIR"
fi
