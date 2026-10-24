#!/usr/bin/env bash
# Give the hub limited, expiring API access to the GPU cluster and print the
# three values to paste into Settings → Private AI → Cluster access.
#
#   ./connect-gpu-cluster.sh --context <gpu-cluster-context>                  token valid 72 h
#   ./connect-gpu-cluster.sh --context <gpu-cluster-context> --duration 168h  a week
#   ./connect-gpu-cluster.sh --context <gpu-cluster-context> --permanent      never expires (not recommended)
#
# Creates (on the GPU cluster): the demo namespace + app, and a service account
# that can read the cluster and change workloads only in tcs-demo-payments.
# Re-run it to renew. The token stops working on its own after --duration; to
# cut access sooner: oc --context <ctx> delete -f gpu-cluster-access.yaml
set -euo pipefail
CTX=""; DURATION="72h"; PERMANENT=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --context) CTX="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --permanent) PERMANENT=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$CTX" ]] || { echo "Usage: $0 --context <gpu-cluster-context> [--duration 72h | --permanent]   (oc config get-contexts lists them)" >&2; exit 2; }
DIR="$(cd "$(dirname "$0")" && pwd)"
g() { oc --context "$CTX" "$@"; }

echo "▶ Applying the demo app and the hub's access on $CTX"
g apply -f "$DIR/scenario-payments.yaml" >/dev/null
g apply -f "$DIR/gpu-cluster-access.yaml" >/dev/null

if $PERMANENT; then
  echo "▶ Issuing a token that does not expire (delete gpu-cluster-access.yaml to revoke it)"
  g apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Secret
metadata:
  name: tcs-agentic-ai-hub-token
  namespace: tcs-agentic-ai-access
  annotations: { kubernetes.io/service-account.name: tcs-agentic-ai-hub }
type: kubernetes.io/service-account-token
YAML
  TOKEN=""
  for _ in $(seq 1 30); do
    TOKEN=$(g -n tcs-agentic-ai-access get secret tcs-agentic-ai-hub-token -o jsonpath='{.data.token}' 2>/dev/null | base64 -d || true)
    [[ -n "$TOKEN" ]] && break; sleep 1
  done
  [[ -n "$TOKEN" ]] || { echo "The token was not issued — check: oc --context $CTX -n tcs-agentic-ai-access get secret" >&2; exit 1; }
  VALID="does not expire"
else
  echo "▶ Issuing a token valid for $DURATION"
  # A token from a previous --permanent run would keep working: remove it.
  g -n tcs-agentic-ai-access delete secret tcs-agentic-ai-hub-token --ignore-not-found >/dev/null
  TOKEN=$(g -n tcs-agentic-ai-access create token tcs-agentic-ai-hub --duration "$DURATION")
  VALID="valid for $DURATION (the cluster may cap it; Settings shows the real expiry)"
fi

API=$(g whoami --show-server)
CA=$(g -n tcs-agentic-ai-access get configmap kube-root-ca.crt -o jsonpath='{.data.ca\.crt}')

OUT="$(mktemp -d)"; chmod 700 "$OUT"
printf '%s\n' "$API" > "$OUT/api-url"; printf '%s' "$TOKEN" > "$OUT/token"; printf '%s\n' "$CA" > "$OUT/ca.crt"; chmod 600 "$OUT"/*

cat <<MSG

✓ Access created on $CTX — token $VALID.
  In the console: Settings → Private AI → GPU cluster = the cluster for $CTX,
  then Cluster access → "Limited access" → paste these three values → Test and save.

API URL:
$API

Token (also in $OUT/token — delete that folder when done):
$TOKEN

CA certificate (also in $OUT/ca.crt):
$CA

MSG
