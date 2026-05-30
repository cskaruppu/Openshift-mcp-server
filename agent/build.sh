#!/usr/bin/env bash
#
# Build and push the TCS Agentic AI Agent image to quay.io
#
# Usage:
#   ./build.sh                 # builds and pushes :latest
#   ./build.sh v1.0.0          # builds and pushes :v1.0.0 + :latest
#
set -euo pipefail

REGISTRY="quay.io/karuppucs"
IMAGE_NAME="tcs-agentic-ai"
TAG="${1:-latest}"
FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}"

cd "$(dirname "$0")"

echo "============================================"
echo "  TCS Agentic AI — Agent Image Builder"
echo "============================================"
echo "Registry : ${REGISTRY}"
echo "Image    : ${IMAGE_NAME}"
echo "Tag      : ${TAG}"
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

# Build
echo "[1/3] Building image..."
${RUNTIME} build -t "${FULL_IMAGE}:${TAG}" -f Dockerfile .

if [ "${TAG}" != "latest" ]; then
  ${RUNTIME} tag "${FULL_IMAGE}:${TAG}" "${FULL_IMAGE}:latest"
fi

echo ""
echo "[2/3] Image built successfully:"
${RUNTIME} images "${FULL_IMAGE}" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"

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
