#!/usr/bin/env bash
# ============================================================================
# TCS Agentic AI — MANAGEMENT BUNDLE deployment
#
# Deploys the complete management plane as ONE unit on the current cluster:
#
#   ┌────────────── Management Bundle ──────────────┐
#   │  Dashboard (React + nginx)   — stateless UI    │
#   │  Control Plane (MCP_MODE=control) — API + auth │
#   │  PostgreSQL                  — all state       │
#   │  Redis                       — LLM reply cache │
#   │  Hub Agent (MCP_MODE=spoke)  — this cluster's  │
#   │                                data plane      │
#   └────────────────────────────────────────────────┘
#
# Every dashboard change (settings, chats, audit, incidents, KB, rules) is
# stored in PostgreSQL. The control plane holds no state on disk.
#
# The hub cluster's own metrics/chat are served by the bundled Hub Agent —
# the SAME stateless MCP server image that runs on every other cluster —
# so answers are identical across the whole fleet.
#
# Usage:
#   ./deploy/dashboard/deploy.sh                  # build + push + deploy
#   ./deploy/dashboard/deploy.sh --no-build       # deploy only
#
# To add more clusters afterwards, run the common MCP server script on each:
#   ./deploy/mcp/deploy.sh --hub-url <dashboard-url> --cluster-name <name>
# ============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/../hub/deploy.sh" "$@"
