#!/usr/bin/env bash
# Connect the platform to the on-prem models and unlock Settings → Private AI.
#
#   ./enable.sh                                   models and platform on the same cluster
#   ./enable.sh --models-context <ctx>            models on another cluster (e.g. the GPU spoke):
#                                                 exposes each model with a Route and points the
#                                                 platform (current context) at the Route URLs
#   ./enable.sh --models-kubeconfig <file>        same, with the GPU cluster in its own kubeconfig file
#                                                 (the platform side uses $KUBECONFIG / the default one)
#   ./enable.sh --route-chat                      also make AI Chat default to the on-prem models
#
# The switches themselves (Command Center, banner, AI Chat routing, GPU cluster)
# are then managed in Settings → Private AI. Undo with ./disable.sh.
set -euo pipefail
NS="${PLATFORM_NS:-openshift-mcp}"
DEPLOY="${PLATFORM_DEPLOY:-agentic-ai-control-plane}"
MODELS_NS="${MODELS_NS:-openshift-mcp}"   # existing namespace; never created or deleted here
HARDWARE="${PRIVATE_AI_HARDWARE:-Dell PowerEdge · 4× NVIDIA H100 · OpenShift AI}"
MCTX=""; MKCFG=""; ROUTE_CHAT=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --models-context)
      [[ -n "${2:-}" ]] || { echo "--models-context needs a context name" >&2; exit 2; }
      MCTX="$2"; shift 2 ;;
    --models-kubeconfig)
      [[ -n "${2:-}" ]] || { echo "--models-kubeconfig needs a file (is \$GPU_KC set in this shell?)" >&2; exit 2; }
      MKCFG="$2"; shift 2 ;;
    --route-chat) ROUTE_CHAT=true; shift ;;
    --keep-llm) shift ;;   # kept for compatibility: AI Chat routing is now a switch in Settings
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
if [[ -n "$MKCFG" ]]; then
  [[ -r "$MKCFG" ]] || { echo "Cannot read kubeconfig: $MKCFG" >&2; exit 2; }
  MCTX="${MCTX:-$(oc --kubeconfig "$MKCFG" config current-context)}"
fi
moc() {
  local a=(); [[ -n "$MKCFG" ]] && a+=(--kubeconfig "$MKCFG"); [[ -n "$MCTX" ]] && a+=(--context "$MCTX")
  oc ${a[@]+"${a[@]}"} "$@"
}

url() { # where the platform reaches a KServe RawDeployment predictor
  local svc="$1-predictor" port host
  port=$(moc -n "$MODELS_NS" get svc "$svc" -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || true)
  if [[ -z "$MCTX" ]]; then echo "http://$svc.$MODELS_NS.svc.cluster.local:${port:-80}"; return; fi
  # Another cluster: in-cluster DNS does not reach it, so expose the predictor with a Route.
  moc -n "$MODELS_NS" get route "$1" >/dev/null 2>&1 || moc -n "$MODELS_NS" expose svc "$svc" --name "$1" >/dev/null
  host=$(moc -n "$MODELS_NS" get route "$1" -o jsonpath='{.spec.host}')
  echo "http://$host"
}

echo "▶ Saving the current settings so disable.sh can restore them"
prev=$(oc -n "$NS" set env deploy/"$DEPLOY" --list 2>/dev/null | grep -E '^(LLM_PROVIDER|PRIVATE_AI_OPS|COMMAND_CENTER_BANNER)=' || true)
oc -n "$NS" create configmap tcs-private-ai-previous --from-literal=env="$prev" --dry-run=client -o yaml | oc apply -f - >/dev/null

echo "▶ Pointing the platform at the models in $MODELS_NS${MCTX:+ on $MCTX}"
ENV=(PRIVATE_AI_OPS=true "PRIVATE_AI_HARDWARE=$HARDWARE")
# Connect only the models that are deployed; a model added later is picked up by running this again.
connect() { # ROLE model gpu-label
  local stopped
  stopped=$(moc -n "$MODELS_NS" get inferenceservice "$2" -o jsonpath='{.metadata.annotations.serving\.kserve\.io/stop}' 2>/dev/null || true)
  if [[ "$stopped" == "true" ]]; then
    ENV+=("PRIVATE_AI_$1_URL-" "PRIVATE_AI_$1_MODEL-" "PRIVATE_AI_$1_GPU-")
    echo "  – $2 (stopped in OpenShift AI, skipped; start it with rhoai/models.sh start $2, then run this again)"
  elif moc -n "$MODELS_NS" get svc "$2-predictor" >/dev/null 2>&1; then
    ENV+=("PRIVATE_AI_$1_URL=$(url "$2")" "PRIVATE_AI_$1_MODEL=$2" "PRIVATE_AI_$1_GPU=$3")
    echo "  ✓ $2"
  else
    ENV+=("PRIVATE_AI_$1_URL-" "PRIVATE_AI_$1_MODEL-" "PRIVATE_AI_$1_GPU-")
    echo "  – $2 (not deployed, skipped)"
  fi
}
connect LARGE  gpt-oss-120b  "H100 · own node"
connect SMALL  llama-3-1-8b  "H100 · shared"
connect VISION qwen2-5-vl-7b "H100 · shared"
connect EMBED  bge-m3        "H100 · shared"
$ROUTE_CHAT && ENV+=(LLM_PROVIDER=private)
oc -n "$NS" set env deploy/"$DEPLOY" "${ENV[@]}"

echo "▶ Applying the Act 2 demo workload${MCTX:+ on $MCTX}"
moc apply -f "$(dirname "$0")/scenario-payments.yaml"

echo "▶ Waiting for the platform to restart"
oc -n "$NS" rollout status deploy/"$DEPLOY" --timeout=300s
echo "✓ Done. Open Settings → Private AI: pick the GPU cluster${MCTX:+ ($MCTX)}, check the prerequisites and turn on the Command Center."
