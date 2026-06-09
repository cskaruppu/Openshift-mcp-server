#!/usr/bin/env bash
# ============================================================================
# TCS Agentic AI — COMMON MCP SERVER deployment (any cluster)
#
# Deploys the stateless MCP server pod on the CURRENT kubectl/oc context and
# registers it with the management bundle (dashboard). Run this once per
# cluster — OpenShift, Rancher, EKS, AKS, GKE, or vanilla K8s.
#
#   Management Bundle (dashboard cluster)
#          ▲ register + heartbeat (30s, carries version for drift detection)
#          │ live proxy for widgets/chat — no caching, no local state
#   ┌──────┴───────┐
#   │  MCP Server  │  MCP_MODE=spoke — stateless, no DB, no secrets stored
#   └──────────────┘
#
# Usage:
#   ./deploy/mcp/deploy.sh --hub-url https://<dashboard-route> \
#                          --cluster-name prod-east --platform openshift
#
#   ./deploy/mcp/deploy.sh --status      # check this cluster's MCP server
#   ./deploy/mcp/deploy.sh --rollback    # roll back to previous revision
#   ./deploy/mcp/deploy.sh --uninstall   # remove from this cluster
#
# After the dashboard image is updated in the registry, you do NOT need to
# rerun this script — use the cluster card's ⋮ → Redeploy button instead
# (clusters showing "Update Available" run an older build).
# ============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/../spoke/deploy.sh" "$@"
