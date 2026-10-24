#!/usr/bin/env bash
# Give the hub direct API access to the GPU cluster and print the three values
# to paste into Settings → Private AI → Cluster access.
#
#   ./connect-gpu-cluster.sh --context <gpu-cluster-context>
#
# Creates (on the GPU cluster): the demo namespace + app, a service account with
# read access cluster-wide and write access in tcs-demo-payments only, and a
# token for it. Undo: oc --context <ctx> delete -f gpu-cluster-access.yaml
set -euo pipefail
CTX=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --context) CTX="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$CTX" ]] || { echo "Usage: $0 --context <gpu-cluster-context>   (oc config get-contexts lists them)" >&2; exit 2; }
DIR="$(cd "$(dirname "$0")" && pwd)"
g() { oc --context "$CTX" "$@"; }

echo "▶ Applying the demo app and the hub's access on $CTX"
g apply -f "$DIR/scenario-payments.yaml" >/dev/null
g apply -f "$DIR/gpu-cluster-access.yaml" >/dev/null

echo "▶ Waiting for the token"
TOKEN=""
for _ in $(seq 1 30); do
  TOKEN=$(g -n tcs-agentic-ai-access get secret tcs-agentic-ai-hub-token -o jsonpath='{.data.token}' 2>/dev/null | base64 -d || true)
  [[ -n "$TOKEN" ]] && break; sleep 1
done
[[ -n "$TOKEN" ]] || { echo "The token was not issued — check: oc --context $CTX -n tcs-agentic-ai-access get secret" >&2; exit 1; }

API=$(g whoami --show-server)
CA=$(g -n tcs-agentic-ai-access get configmap kube-root-ca.crt -o jsonpath='{.data.ca\.crt}')

OUT="$(mktemp -d)"; chmod 700 "$OUT"
printf '%s\n' "$API" > "$OUT/api-url"; printf '%s' "$TOKEN" > "$OUT/token"; printf '%s\n' "$CA" > "$OUT/ca.crt"; chmod 600 "$OUT"/*

cat <<EOF

✓ Access created on $CTX. In the console: Settings → Private AI → GPU cluster = $CTX,
  then Cluster access → paste these three values → Test → Save.

API URL:
$API

Token (also in $OUT/token — delete that folder when done):
$TOKEN

CA certificate (also in $OUT/ca.crt):
$CA

EOF
