#!/usr/bin/env bash
# Turn the Private AI Operations Center OFF and restore the AI provider that
# was set before ./enable.sh. The models in tcs-private-ai and the demo
# workload are left running; pass --remove-demo to delete the demo namespace.
set -euo pipefail
NS="${PLATFORM_NS:-openshift-mcp}"
DEPLOY="${PLATFORM_DEPLOY:-agentic-ai-control-plane}"

echo "▶ Restoring internet egress for the platform (if it was cut)"
oc -n "$NS" delete networkpolicy tcs-private-ai-no-internet --ignore-not-found

echo "▶ Removing the Private AI settings"
oc -n "$NS" set env deploy/"$DEPLOY" PRIVATE_AI_OPS- COMMAND_CENTER_BANNER- PRIVATE_AI_HARDWARE- \
  PRIVATE_AI_LARGE_URL- PRIVATE_AI_LARGE_MODEL- PRIVATE_AI_LARGE_GPU- \
  PRIVATE_AI_SMALL_URL- PRIVATE_AI_SMALL_MODEL- PRIVATE_AI_SMALL_GPU- \
  PRIVATE_AI_VISION_URL- PRIVATE_AI_VISION_MODEL- PRIVATE_AI_VISION_GPU- \
  PRIVATE_AI_EMBED_URL- PRIVATE_AI_EMBED_MODEL- PRIVATE_AI_EMBED_GPU- LLM_PROVIDER-

prev=$(oc -n "$NS" get configmap tcs-private-ai-previous -o jsonpath='{.data.env}' 2>/dev/null || true)
if [[ -n "$prev" ]]; then
  echo "▶ Restoring the previous AI provider settings"
  # shellcheck disable=SC2086
  oc -n "$NS" set env deploy/"$DEPLOY" $(echo "$prev" | grep '^LLM_PROVIDER=' || true)
  oc -n "$NS" delete configmap tcs-private-ai-previous --ignore-not-found
fi

if [[ "${1:-}" == "--remove-demo" ]]; then
  echo "▶ Deleting the demo workload"
  oc delete namespace tcs-demo-payments --ignore-not-found
fi
oc -n "$NS" rollout status deploy/"$DEPLOY" --timeout=300s
echo "✓ Command Center off. The launchers are gone; AI Chat uses the previous provider."
