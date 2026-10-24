#!/usr/bin/env bash
# Turn the Private AI Operations Center ON.
#
#   ./enable.sh                 all features, AI routed to the on-prem models
#   ./enable.sh --keep-llm      Command Center on, but leave the current AI provider as it is
#
# Undo everything with ./disable.sh — it restores the AI provider that was set
# before (saved in the ConfigMap tcs-private-ai-previous).
set -euo pipefail
NS="${PLATFORM_NS:-openshift-mcp}"
DEPLOY="${PLATFORM_DEPLOY:-agentic-ai-control-plane}"
MODELS_NS="${MODELS_NS:-tcs-private-ai}"
HARDWARE="${PRIVATE_AI_HARDWARE:-Dell PowerEdge · 2× NVIDIA H100 · OpenShift AI}"
KEEP_LLM=false; [[ "${1:-}" == "--keep-llm" ]] && KEEP_LLM=true

svc() { # in-cluster URL of a KServe RawDeployment predictor
  local port; port=$(oc -n "$MODELS_NS" get svc "$1-predictor" -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || true)
  echo "http://$1-predictor.$MODELS_NS.svc.cluster.local:${port:-80}"
}

echo "▶ Saving the current AI provider settings so disable.sh can restore them"
prev=$(oc -n "$NS" set env deploy/"$DEPLOY" --list 2>/dev/null | grep -E '^(LLM_PROVIDER|PRIVATE_AI_OPS|COMMAND_CENTER_BANNER)=' || true)
oc -n "$NS" create configmap tcs-private-ai-previous --from-literal=env="$prev" --dry-run=client -o yaml | oc apply -f - >/dev/null

echo "▶ Pointing the platform at the models in $MODELS_NS"
ENV=(
  PRIVATE_AI_OPS=true
  COMMAND_CENTER_BANNER=true
  "PRIVATE_AI_HARDWARE=$HARDWARE"
  "PRIVATE_AI_LARGE_URL=$(svc gpt-oss-120b)"   PRIVATE_AI_LARGE_MODEL=gpt-oss-120b   "PRIVATE_AI_LARGE_GPU=GPU 0 · H100"
  "PRIVATE_AI_SMALL_URL=$(svc llama-3-1-8b)"   PRIVATE_AI_SMALL_MODEL=llama-3-1-8b   "PRIVATE_AI_SMALL_GPU=GPU 1 · MIG 3g.40gb"
  "PRIVATE_AI_VISION_URL=$(svc qwen2-5-vl-7b)" PRIVATE_AI_VISION_MODEL=qwen2-5-vl-7b "PRIVATE_AI_VISION_GPU=GPU 1 · MIG 2g.20gb"
  "PRIVATE_AI_EMBED_URL=$(svc bge-m3)"         PRIVATE_AI_EMBED_MODEL=bge-m3         "PRIVATE_AI_EMBED_GPU=GPU 1 · MIG 1g.10gb"
)
$KEEP_LLM || ENV+=(LLM_PROVIDER=private)
oc -n "$NS" set env deploy/"$DEPLOY" "${ENV[@]}"

echo "▶ Applying the Act 2 demo workload"
oc apply -f "$(dirname "$0")/scenario-payments.yaml"

echo "▶ Waiting for the platform to restart"
oc -n "$NS" rollout status deploy/"$DEPLOY" --timeout=300s
echo "✓ Done. Open the workspace screen: the Command Center button is in the header."
