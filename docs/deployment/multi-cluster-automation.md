# TCS Agentic AI — Multi-Cluster Automation Deployment Guide

## Overview

Deploy the TCS Agentic AI MCP server across multiple OpenShift/Kubernetes clusters.
Same image, same code — the only difference per cluster is the ServiceAccount/KUBECONFIG.

---

## Prerequisites

- OpenShift CLI (`oc`) or `kubectl`
- Container registry access (quay.io, Docker Hub, or internal)
- ServiceNow PDI credentials (for ITSM)
- Anthropic API key (for AI)

---

## Quick Start

```bash
# 1. Edit deploy/deploy-all.sh — add your cluster context names
# 2. Set your image registry
export TCS_IMAGE=your-registry/tcs-agentic-ai:latest

# 3. Deploy to all clusters
./deploy/deploy-all.sh

# 4. Check status
./deploy/deploy-all.sh --status

# 5. Rollback if needed
./deploy/deploy-all.sh --rollback
```

---

## Step-by-Step

### 1. Create Namespace (each cluster)

```bash
oc new-project openshift-tcs-agentic
```

### 2. Create Secrets (each cluster)

```bash
oc create secret generic tcs-agentic-ai-secrets \
  --namespace=openshift-tcs-agentic \
  --from-literal=ANTHROPIC_API_KEY=your-key \
  --from-literal=SERVICENOW_INSTANCE=your-instance.service-now.com \
  --from-literal=SERVICENOW_USER=your-user \
  --from-literal=SERVICENOW_PASSWORD=your-password \
  --from-literal=MCP_API_TOKEN=your-mcp-token
```

### 3. Deploy (each cluster)

```bash
oc apply -f deploy/deployment.yaml
oc apply -f deploy/route.yaml
```

### 4. Verify

```bash
# Check pod status
oc get pods -n openshift-tcs-agentic

# Check health endpoint
ROUTE=$(oc get route tcs-agentic-ai -n openshift-tcs-agentic -o jsonpath='{.spec.host}')
curl -sk "https://$ROUTE/api/health"
```

---

## Automation Script

`deploy/deploy-all.sh` supports:

| Command | Action |
|---|---|
| `./deploy/deploy-all.sh` | Build + deploy to ALL clusters |
| `./deploy/deploy-all.sh prod-us` | Deploy to single cluster |
| `./deploy/deploy-all.sh --status` | Health check all clusters |
| `./deploy/deploy-all.sh --rollback` | Rollback all clusters |

---

## Adding a New Cluster

1. Add context name to `CLUSTERS` array in `deploy/deploy-all.sh`
2. Run `./deploy/deploy-all.sh new-cluster-name`
3. Register the spoke cluster as an agent in the hub's Agent Registry

---

## Rollback

```bash
# Rollback all clusters to previous version
./deploy/deploy-all.sh --rollback

# Rollback single cluster
oc config use-context prod-us-east
oc rollout undo deployment/tcs-agentic-ai -n openshift-tcs-agentic
```

---

## Validation Checklist (per cluster)

- [ ] `curl https://<route>/api/health` returns 200
- [ ] Login page loads
- [ ] Cluster picker shows registered clusters
- [ ] Dashboard widgets load
- [ ] AI Chat responds
- [ ] ServiceNow INC creation works
- [ ] Theme toggle works
- [ ] Command palette (Ctrl+K) opens

---

## Troubleshooting

| Issue | Fix |
|---|---|
| CrashLoopBackOff | Check secrets: `oc get secret tcs-agentic-ai-secrets` |
| 401 errors | Recreate MCP_API_TOKEN |
| No dashboard data | Check ClusterRoleBinding for cluster-reader |
| Route not accessible | Check TLS: `oc get route tcs-agentic-ai -o yaml` |
| ServiceNow errors | Verify SERVICENOW_* env vars |
