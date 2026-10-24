#!/usr/bin/env bash
# Switch Private AI off for good on this deployment and restore the AI provider
# that was set before ./enable.sh. PRIVATE_AI_OPS=false overrides anything saved
# in Settings → Private AI, so every launcher disappears. The models and the
# demo workload are left running:
#   ./disable.sh --remove-demo [--models-context <ctx>]   also deletes the demo namespace
set -euo pipefail
NS="${PLATFORM_NS:-openshift-mcp}"
DEPLOY="${PLATFORM_DEPLOY:-agentic-ai-control-plane}"
REMOVE_DEMO=false; MCTX=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --remove-demo) REMOVE_DEMO=true; shift ;;
    --models-context) MCTX="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

echo "▶ Restoring internet egress for the platform (if it was cut)"
oc -n "$NS" delete networkpolicy tcs-private-ai-no-internet --ignore-not-found

echo "▶ Switching Private AI off and removing the model endpoints"
oc -n "$NS" set env deploy/"$DEPLOY" PRIVATE_AI_OPS=false COMMAND_CENTER_BANNER- PRIVATE_AI_HARDWARE- \
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

if $REMOVE_DEMO; then
  echo "▶ Deleting the demo workload"
  if [[ -n "$MCTX" ]]; then oc --context "$MCTX" delete namespace tcs-demo-payments --ignore-not-found
  else oc delete namespace tcs-demo-payments --ignore-not-found; fi
fi
oc -n "$NS" rollout status deploy/"$DEPLOY" --timeout=300s
echo "✓ Private AI off. The launchers are gone; AI Chat uses the previous provider."
echo "  To manage it from Settings again, run ./enable.sh (it removes PRIVATE_AI_OPS=false)."
