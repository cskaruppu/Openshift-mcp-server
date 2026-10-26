#!/usr/bin/env bash
# Deploy the four Private AI models through OpenShift AI (KServe) in the existing openshift-mcp
# namespace, the standard way: OpenShift AI's own vLLM serving runtime (from the template it ships),
# a custom TEI runtime for embeddings, weights downloaded once into PVCs, HAMi GPU memory slices.
#
#   ./deploy-rhoai.sh [--kubeconfig <gpu-cluster-file>] [--only <model>] [--dashboard]
#
#   --only <model>   deploy one model (bge-m3, llama-3-1-8b, qwen2-5-vl-7b, gpt-oss-120b); default all,
#                    smallest first, each one checked before the next
#   --dashboard      also label openshift-mcp so its models show in the OpenShift AI dashboard
#   --download-here  download the weights on THIS machine (needs internet + python3) and copy them
#                    into the claims, for clusters whose pods cannot reach huggingface.co
#                    (local copy kept in \$MODELS_DIR, default ~/tcs-models)
#
# Needs: OpenShift AI with KServe Managed and its pods Running; Secret hf-token in openshift-mcp
# (oc -n openshift-mcp create secret generic hf-token --from-literal=HF_TOKEN=<token>).
# Remove with:  oc -n openshift-mcp delete inferenceservice -l tcs.com/demo=private-ai-ops
# (the downloaded weights stay in the *-cache claims).
set -euo pipefail
NS=openshift-mcp
HERE="$(cd "$(dirname "$0")" && pwd)"
KC=""; ONLY=""; DASH=false; HERE_DL=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --kubeconfig) KC="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --dashboard) DASH=true; shift ;;
    --download-here) HERE_DL=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
o() { if [[ -n "$KC" ]]; then oc --kubeconfig "$KC" "$@"; else oc "$@"; fi; }

# name | Hugging Face repo | PVC size | files to skip | manifest
MODELS=(
  "bge-m3|BAAI/bge-m3|20Gi|onnx/*,imgs/*|20-bge-m3.yaml"
  "llama-3-1-8b|meta-llama/Llama-3.1-8B-Instruct|60Gi|original/*|30-llama-3-1-8b.yaml"
  "qwen2-5-vl-7b|Qwen/Qwen2.5-VL-7B-Instruct|60Gi||35-qwen2-5-vl-7b.yaml"
  "gpt-oss-120b|openai/gpt-oss-120b|200Gi|original/*,metal/*|40-gpt-oss-120b.yaml"
)

echo "▶ Cluster: $(o whoami --show-server)"
echo "▶ Checking prerequisites"
o get ns "$NS" >/dev/null
o -n redhat-ods-applications get deploy kserve-controller-manager >/dev/null || { echo "✗ OpenShift AI KServe controller not found" >&2; exit 1; }
o -n redhat-ods-applications rollout status deploy/kserve-controller-manager --timeout=60s >/dev/null || { echo "✗ kserve-controller-manager is not ready" >&2; exit 1; }
o -n "$NS" get secret hf-token >/dev/null 2>&1 || echo "  ! Secret hf-token not found: Llama (gated) will fail to download"
if o -n "$NS" get deploy -l tcs.com/demo=private-ai-ops -o name 2>/dev/null | grep -q .; then
  echo "✗ The plain-Deployment models are present. Remove them first (weights in the claims are kept):" >&2
  echo "    oc -n $NS delete deploy,svc -l tcs.com/demo=private-ai-ops" >&2; exit 1
fi
$DASH && o label ns "$NS" opendatahub.io/dashboard=true modelmesh-enabled=false --overwrite >/dev/null && echo "  ✓ $NS shown in the OpenShift AI dashboard"

echo "▶ OpenShift AI vLLM runtime"
TPL=$(o -n redhat-ods-applications get templates -o name | grep -i vllm | grep -i cuda | head -1 || true)
[[ -n "$TPL" ]] || TPL=$(o -n redhat-ods-applications get templates -o name | grep -i vllm | head -1 || true)
[[ -n "$TPL" ]] || { echo "✗ No vLLM serving runtime template in redhat-ods-applications" >&2; exit 1; }
RT_JSON=$(o process -n redhat-ods-applications "${TPL#template.template.openshift.io/}" -o json)
VLLM_RT=$(echo "$RT_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["items"][0]["metadata"]["name"])')
VLLM_IMG=$(echo "$RT_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["items"][0]["spec"]["containers"][0]["image"])')
echo "$RT_JSON" | o apply -n "$NS" -f - >/dev/null
echo "  ✓ $VLLM_RT  ($VLLM_IMG)"
o apply -f "$HERE/10-tei-runtime.yaml" >/dev/null && echo "  ✓ tei-runtime"

restarts() { o -n redhat-ods-applications get pods -o jsonpath='{range .items[*]}{.status.containerStatuses[0].restartCount}{"\n"}{end}' | awk '{s+=$1} END {print s+0}'; }

# The cluster-wide proxy (if any) is not passed to pods automatically; the download needs it
# to reach huggingface.co. The models themselves never need it.
HP=$(o get proxy cluster -o jsonpath='{.status.httpsProxy}' 2>/dev/null || true)
HPP=$(o get proxy cluster -o jsonpath='{.status.httpProxy}' 2>/dev/null || true)
NP=$(o get proxy cluster -o jsonpath='{.status.noProxy}' 2>/dev/null || true)
PROXY_ENV=""
[[ -n "$HP$HPP" ]] && PROXY_ENV="            - { name: HTTPS_PROXY, value: \"${HP:-$HPP}\" }
            - { name: HTTP_PROXY, value: \"${HPP:-$HP}\" }
            - { name: NO_PROXY, value: \"$NP\" }" && echo "  ✓ downloads go through the cluster proxy ${HP:-$HPP}"

download() { # name repo size skip
  local n="$1" repo="$2" size="$3" skip="$4"
  o -n "$NS" get pvc "$n-cache" >/dev/null 2>&1 || cat <<YAML | o apply -f - >/dev/null
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: $n-cache, namespace: $NS, labels: { tcs.com/demo: private-ai-ops } }
spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: $size } } }
YAML
  o -n "$NS" delete job "download-$n" --ignore-not-found >/dev/null
  cat <<YAML | o apply -f - >/dev/null
apiVersion: batch/v1
kind: Job
metadata: { name: download-$n, namespace: $NS, labels: { tcs.com/demo: private-ai-ops } }
spec:
  backoffLimit: 1
  activeDeadlineSeconds: 10800
  template:
    metadata: { labels: { tcs.com/demo: private-ai-ops } }
    spec:
      restartPolicy: Never   # failed pods are kept, so their logs can be read
      containers:
        - name: download
          image: $VLLM_IMG
          command: ["python3", "-c"]
          args:
            - |
              import os, sys, socket, pathlib
              os.environ["HF_HUB_OFFLINE"] = "0"
              d = pathlib.Path("/cache/model"); done = d / ".tcs-complete"
              if done.exists(): print("already downloaded"); sys.exit(0)
              try:
                  from huggingface_hub import snapshot_download
              except Exception as e:
                  print("ERROR: this image has no huggingface_hub:", e); sys.exit(3)
              if not (os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")):
                  try: socket.getaddrinfo("huggingface.co", 443)
                  except Exception as e:
                      print("ERROR: the cluster cannot resolve huggingface.co (no internet/DNS from pods):", e)
                      print("HINT: run deploy-rhoai.sh with --download-here to download on this machine instead"); sys.exit(4)
              skip = [p for p in os.environ.get("SKIP", "").split(",") if p]
              try:
                  snapshot_download(os.environ["REPO"], local_dir=str(d), ignore_patterns=skip or None,
                                    token=os.environ.get("HF_TOKEN") or None)
              except Exception as e:
                  print("ERROR:", type(e).__name__, str(e)[:600])
                  print("HINT: 401/403/gated = accept the licence and check the hf-token Secret; "
                        "connection errors = no internet from the cluster (use --download-here)"); sys.exit(5)
              done.write_text("ok"); print("downloaded", os.environ["REPO"])
          env:
            - { name: REPO, value: "$repo" }
            - { name: SKIP, value: "$skip" }
            - { name: HOME, value: /tmp }
            - { name: HF_HOME, value: /tmp/hf }
            # Red Hat's vLLM image sets HF_HUB_OFFLINE=1 (serving never downloads); the download must not be offline.
            - { name: HF_HUB_OFFLINE, value: "0" }
            - { name: TRANSFORMERS_OFFLINE, value: "0" }
$PROXY_ENV
            - name: HF_TOKEN
              valueFrom: { secretKeyRef: { name: hf-token, key: HF_TOKEN, optional: true } }
          resources: { requests: { cpu: "1", memory: 2Gi }, limits: { cpu: "4", memory: 8Gi } }
          volumeMounts: [{ name: cache, mountPath: /cache }]
      volumes: [{ name: cache, persistentVolumeClaim: { claimName: $n-cache } }]
YAML
  echo "  … downloading $repo (oc -n $NS logs -f job/download-$n)"
  local st=""
  for _ in $(seq 1 540); do   # up to 3 h
    st=$(o -n "$NS" get job "download-$n" -o jsonpath='{range .status.conditions[?(@.status=="True")]}{.type}{" "}{end}' 2>/dev/null || true)
    [[ "$st" == *Complete* || "$st" == *Fail* ]] && break
    sleep 20
  done
  if [[ "$st" != *Complete* ]]; then
    echo "✗ Download of $repo did not finish (job: ${st:-no status}). Last log lines:" >&2
    o -n "$NS" get pods -l job-name="download-$n" -o wide >&2 || true
    for p in $(o -n "$NS" get pods -l job-name="download-$n" -o name 2>/dev/null); do o -n "$NS" logs "$p" --tail=25 >&2 || true; done
    exit 1
  fi
  echo "  ✓ weights in $n-cache"
}

download_here() { # name repo skip  — download on this machine, copy into the claim via a helper pod
  local n="$1" repo="$2" skip="$3" dir="${MODELS_DIR:-$HOME/tcs-models}/$n" pod="copy-$n"
  o -n "$NS" delete pod "$pod" --ignore-not-found >/dev/null
  cat <<YAML | o apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata: { name: $pod, namespace: $NS, labels: { tcs.com/demo: private-ai-ops } }
spec:
  restartPolicy: Never
  containers:
    - name: copy
      image: $VLLM_IMG
      command: ["sleep", "86400"]
      volumeMounts: [{ name: cache, mountPath: /cache }]
  volumes: [{ name: cache, persistentVolumeClaim: { claimName: $n-cache } }]
YAML
  o -n "$NS" wait --for=condition=Ready "pod/$pod" --timeout=10m >/dev/null \
    || { echo "✗ Helper pod $pod did not start: oc -n $NS describe pod $pod" >&2; exit 1; }
  if o -n "$NS" exec "$pod" -- test -f /cache/model/.tcs-complete 2>/dev/null; then
    o -n "$NS" delete pod "$pod" --wait=false >/dev/null; echo "  ✓ already in $n-cache"; return
  fi
  python3 -c 'import huggingface_hub' 2>/dev/null || python3 -m pip install --user -q huggingface_hub \
    || { echo "✗ Install huggingface_hub here first: python3 -m pip install --user huggingface_hub" >&2; exit 1; }
  local tok="${HF_TOKEN:-$(o -n "$NS" get secret hf-token -o jsonpath='{.data.HF_TOKEN}' 2>/dev/null | base64 -d 2>/dev/null || true)}"
  echo "  … downloading $repo to $dir (on this machine)"
  mkdir -p "$dir"
  HF_HUB_OFFLINE=0 REPO="$repo" SKIP="$skip" DIR="$dir" HF_TOKEN="$tok" python3 - <<'PY' || { echo "✗ Download of $repo failed on this machine" >&2; exit 1; }
import os
from huggingface_hub import snapshot_download
skip = [p for p in os.environ["SKIP"].split(",") if p]
snapshot_download(os.environ["REPO"], local_dir=os.environ["DIR"], ignore_patterns=skip or None,
                  token=os.environ.get("HF_TOKEN") or None)
PY
  rm -rf "$dir/.cache"
  echo "  … copying $(du -sh "$dir" | cut -f1) into $n-cache (can take a while for large models)"
  o -n "$NS" exec "$pod" -- mkdir -p /cache/model
  o -n "$NS" rsync --strategy=tar --progress=false "$dir/" "$pod:/cache/model/" >/dev/null \
    || { echo "✗ Copy into $n-cache failed" >&2; exit 1; }
  o -n "$NS" exec "$pod" -- sh -c 'echo ok > /cache/model/.tcs-complete'
  o -n "$NS" delete pod "$pod" --wait=false >/dev/null
  echo "  ✓ weights in $n-cache"
}

for m in "${MODELS[@]}"; do
  IFS='|' read -r n repo size skip file <<<"$m"
  [[ -z "$ONLY" || "$ONLY" == "$n" ]] || continue
  echo "▶ $n"
  if $HERE_DL; then
    o -n "$NS" get pvc "$n-cache" >/dev/null 2>&1 || cat <<YAML | o apply -f - >/dev/null
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: $n-cache, namespace: $NS, labels: { tcs.com/demo: private-ai-ops } }
spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: $size } } }
YAML
    download_here "$n" "$repo" "$skip"
  else
    download "$n" "$repo" "$size" "$skip"
  fi
  before=$(restarts)
  sed "s/__VLLM_RUNTIME__/$VLLM_RT/" "$HERE/$file" | o apply -f - >/dev/null
  echo "  … starting (oc -n $NS get pods -l serving.kserve.io/inferenceservice=$n)"
  if ! o -n "$NS" wait --for=condition=Ready "inferenceservice/$n" --timeout=30m >/dev/null; then
    echo "✗ $n not ready after 30 min. Check:" >&2
    echo "    oc -n $NS describe inferenceservice $n | tail -20" >&2
    echo "    oc -n $NS logs deploy/$n-predictor --tail=40" >&2; exit 1
  fi
  after=$(restarts)
  echo "  ✓ $n ready ($(o -n "$NS" get inferenceservice "$n" -o jsonpath='{.status.url}'))"
  [[ "$after" -le "$before" ]] || echo "  ! OpenShift AI controllers restarted $((after - before))× while deploying $n: oc -n redhat-ods-applications get pods"
done
echo "✓ Done. Connect the platform from the hub: ./enable.sh --models-kubeconfig <gpu-cluster-kubeconfig>"
