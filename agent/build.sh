#!/usr/bin/env bash
#
# Build and push the TCS Agentic AI Agent image to quay.io
#
# Usage:
#   ./build.sh                 # builds from local files and pushes :latest
#   ./build.sh v1.0.0          # builds and pushes :v1.0.0 + :latest
#   ./build.sh --pull           # pulls latest code from GitHub, then builds :latest
#   ./build.sh --pull v1.0.0   # pulls latest code, then builds :v1.0.0 + :latest
#   ./build.sh --clone         # clones fresh from GitHub into /tmp, builds :latest
#   ./build.sh --no-push       # build only, skip push to registry
#
set -euo pipefail

REGISTRY="quay.io/karuppucs"
IMAGE_NAME="tcs-agentic-ai"
REPO_URL="https://github.com/cskaruppu/openshift-mcp-server.git"
BRANCH="${BUILD_BRANCH:-main}"
PULL=false
CLONE=false
PUSH=true
TAG="latest"

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --pull)   PULL=true ;;
    --clone)  CLONE=true ;;
    --no-push) PUSH=false ;;
    -*)       echo "Unknown flag: $arg"; exit 1 ;;
    *)        TAG="$arg" ;;
  esac
done

FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}"

echo "============================================"
echo "  TCS Agentic AI — Agent Image Builder"
echo "============================================"
echo "Registry : ${REGISTRY}"
echo "Image    : ${IMAGE_NAME}"
echo "Tag      : ${TAG}"
echo "Source   : ${REPO_URL}"
echo "Branch   : ${BRANCH}"
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
echo "Runtime  : ${RUNTIME}"
echo ""

# Determine build context directory
BUILD_DIR="$(cd "$(dirname "$0")" && pwd)"
CLEANUP_DIR=""

if [ "$CLONE" = true ]; then
  echo "[0/4] Cloning latest code from GitHub..."
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
    echo "[0/4] Pulling latest code from GitHub..."
    git -C "${REPO_ROOT}" fetch origin "${BRANCH}" 2>&1
    git -C "${REPO_ROOT}" checkout "${BRANCH}" 2>&1
    git -C "${REPO_ROOT}" pull origin "${BRANCH}" 2>&1
    echo "  Updated to: $(git -C "${REPO_ROOT}" log --oneline -1)"
    echo ""
  else
    echo "ERROR: --pull requires running from within the git repo."
    echo "  Use --clone instead to build from a fresh checkout."
    exit 1
  fi
else
  echo "[info] Building from local files. Use --pull or --clone to fetch latest from GitHub."
  echo ""
fi

# Build
echo "[1/3] Building image from ${BUILD_DIR}..."
${RUNTIME} build -t "${FULL_IMAGE}:${TAG}" -f "${BUILD_DIR}/Dockerfile" "${BUILD_DIR}"

if [ "${TAG}" != "latest" ]; then
  ${RUNTIME} tag "${FULL_IMAGE}:${TAG}" "${FULL_IMAGE}:latest"
fi

echo ""
echo "[2/3] Image built successfully:"
${RUNTIME} images "${FULL_IMAGE}" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"

if [ "$PUSH" = true ]; then
  echo ""
  echo "[3/3] Pushing to ${REGISTRY}..."
  echo "  Make sure you are logged in: ${RUNTIME} login quay.io"
  echo ""

  ${RUNTIME} push "${FULL_IMAGE}:${TAG}"
  if [ "${TAG}" != "latest" ]; then
    ${RUNTIME} push "${FULL_IMAGE}:latest"
  fi

  echo ""
  echo "============================================"
  echo "  Push complete!"
  echo ""
  echo "  Pull: ${RUNTIME} pull ${FULL_IMAGE}:${TAG}"
  echo "  Deploy: kubectl apply -f tcs-agentic-ai.yaml"
  echo "============================================"
else
  echo ""
  echo "[3/3] Skipping push (--no-push). Image available locally:"
  echo "  ${FULL_IMAGE}:${TAG}"
fi

# Cleanup temp clone if used
if [ -n "$CLEANUP_DIR" ] && [ -d "$CLEANUP_DIR" ]; then
  rm -rf "$CLEANUP_DIR"
  echo "  Cleaned up temp clone."
fi
