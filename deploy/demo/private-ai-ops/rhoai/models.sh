#!/usr/bin/env bash
# Stop, start or check the Private AI models on the GPU cluster, to free the H100s when the
# demo is not running. Stopping keeps the downloaded weights, so starting again takes minutes.
#
#   ./models.sh status [--kubeconfig <file>]
#   ./models.sh stop   [--kubeconfig <file>] [model ...]    free the GPUs (weights kept)
#   ./models.sh start  [--kubeconfig <file>] [model ...]    bring them back
#   ./models.sh remove [--kubeconfig <file>] --yes          delete models, weights and runtimes
#
# Models: bge-m3 llama-3-1-8b qwen2-5-vl-7b gpt-oss-120b (default: all four).
# While the models are stopped, switch off "Route AI Chat to the on-prem models" in
# Settings → Private AI, so AI Chat uses the regular AI provider.
set -euo pipefail
NS=openshift-mcp
HERE="$(cd "$(dirname "$0")" && pwd)"
ALL=(bge-m3 llama-3-1-8b qwen2-5-vl-7b gpt-oss-120b)
CMD="${1:-status}"; shift || true
KC=""; YES=false; SEL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --kubeconfig) KC="$2"; shift 2 ;;
    --yes) YES=true; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) SEL+=("$1"); shift ;;
  esac
done
[[ ${#SEL[@]} -gt 0 ]] || SEL=("${ALL[@]}")
o() { if [[ -n "$KC" ]]; then oc --kubeconfig "$KC" "$@"; else oc "$@"; fi; }
exists() { o -n "$NS" get inferenceservice "$1" >/dev/null 2>&1; }
pods_of() { o -n "$NS" get pods -l "serving.kserve.io/inferenceservice=$1" --no-headers 2>/dev/null | grep -v -c Terminating || true; }

status() {
  echo "▶ Cluster: $(o whoami --show-server)"
  echo
  printf "%-16s %-13s %-6s %-10s %s\n" MODEL STATE PODS GPU_MEM WEIGHTS
  for m in "${ALL[@]}"; do
    local state="not deployed" mem="-" w="-" pods
    if exists "$m"; then
      [[ "$(o -n "$NS" get inferenceservice "$m" -o jsonpath='{.metadata.annotations.serving\.kserve\.io/stop}')" == "true" ]] && state="stopped" \
        || state=$([[ "$(o -n "$NS" get inferenceservice "$m" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')" == "True" ]] && echo ready || echo starting)
      mem=$(o -n "$NS" get inferenceservice "$m" -o jsonpath='{.spec.predictor.model.resources.limits.nvidia\.com/gpumem}')
      mem="${mem:+$((mem / 1024)) GB}"
    fi
    pods=$(pods_of "$m")
    [[ "$state" == "stopped" || "$state" == "not deployed" ]] && [[ "$pods" -eq 0 ]] && mem="0 (free)"
    o -n "$NS" get pvc "$m-cache" >/dev/null 2>&1 && w="kept ($m-cache)"
    printf "%-16s %-13s %-6s %-10s %s\n" "$m" "$state" "$pods" "${mem:--}" "$w"
  done
}

stop() {
  for m in "${SEL[@]}"; do
    exists "$m" || { echo "  – $m not deployed"; continue; }
    o -n "$NS" annotate inferenceservice "$m" serving.kserve.io/stop=true --overwrite >/dev/null
    echo "  … stopping $m"
  done
  # OpenShift AI versions without the stop setting keep the pods: remove those models instead
  # (the weights stay in the claims; "start" re-creates them).
  for _ in $(seq 1 24); do
    local left=0; for m in "${SEL[@]}"; do exists "$m" && left=$((left + $(pods_of "$m"))); done
    [[ $left -eq 0 ]] && break; sleep 5
  done
  for m in "${SEL[@]}"; do
    if exists "$m" && [[ $(pods_of "$m") -gt 0 ]]; then
      echo "  ! $m still running after 2 min (this OpenShift AI has no stop setting): removing it, weights kept"
      o -n "$NS" delete inferenceservice "$m" --wait=false >/dev/null
    fi
  done
  echo "✓ Stopped. GPU memory is released as the pods end (oc -n $NS get pods -l tcs.com/demo=private-ai-ops)."
  echo "  In Settings → Private AI, switch off \"Route AI Chat to the on-prem models\" while they are stopped."
}

start() {
  local missing=()
  for m in "${SEL[@]}"; do
    if exists "$m"; then
      o -n "$NS" annotate inferenceservice "$m" serving.kserve.io/stop=false --overwrite >/dev/null
      echo "  … starting $m"
    else
      missing+=("$m")
    fi
  done
  for m in "${missing[@]+"${missing[@]}"}"; do
    echo "  … $m is not deployed: deploying it (weights already downloaded are reused)"
    "$HERE/deploy-rhoai.sh" ${KC:+--kubeconfig "$KC"} --only "$m"
  done
  for m in "${SEL[@]}"; do
    exists "$m" || continue
    o -n "$NS" wait --for=condition=Ready "inferenceservice/$m" --timeout=20m >/dev/null \
      && echo "  ✓ $m ready" || echo "  ✗ $m not ready after 20 min: oc -n $NS logs deploy/$m-predictor -c kserve-container --tail=40"
  done
  echo "✓ Started. In Settings → Private AI press Re-check, then switch on \"Route AI Chat to the on-prem models\"."
}

remove() {
  $YES || { echo "This deletes the models, their downloaded weights (~120 GB) and the runtimes in $NS."; echo "Re-run with --yes to confirm."; exit 1; }
  o -n "$NS" delete inferenceservice,job -l tcs.com/demo=private-ai-ops --ignore-not-found
  o -n "$NS" delete pod -l tcs.com/demo=private-ai-ops --ignore-not-found
  for m in "${ALL[@]}"; do o -n "$NS" delete pvc "$m-cache" --ignore-not-found; done
  o -n "$NS" delete servingruntime tei-runtime vllm-cuda-runtime --ignore-not-found
  echo "✓ Removed. Deploy again with ./deploy-rhoai.sh (downloads everything again)."
}

case "$CMD" in
  status) status ;;
  stop) stop; echo; status ;;
  start) start; echo; status ;;
  remove) remove ;;
  *) echo "Usage: $0 status|stop|start|remove [--kubeconfig <file>] [model ...]" >&2; exit 2 ;;
esac
