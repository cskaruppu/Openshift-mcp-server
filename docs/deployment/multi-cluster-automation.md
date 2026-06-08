# TCS Agentic AI — Multi-Cluster Automation Deployment Guide

## Overview

This guide covers deploying the TCS Agentic AI MCP server across multiple OpenShift/Kubernetes clusters.
The same image, same code, same config is deployed on every cluster — the only difference is the
KUBECONFIG/ServiceAccount that Kubernetes provides automatically.

---

## Prerequisites

- OpenShift CLI (`oc`) or `kubectl` installed
- Access to all target clusters
- Container registry access (e.g., quay.io, Docker Hub, or internal registry)
- ServiceNow PDI credentials (for ITSM integration)
- Anthropic API key (for AI features)

---

## Step 1: Build the Container Image

```bash
# From the project root
docker build -t your-registry/tcs-agentic-ai:latest .

# Push to registry
docker push your-registry/tcs-agentic-ai:latest
```

---

## Step 2: Create Namespace on Each Cluster

Run this on EVERY cluster:

```bash
# For OpenShift
oc new-project openshift-tcs-agentic

# For vanilla Kubernetes
kubectl create namespace tcs-agentic-system
```

---

## Step 3: Create Secrets on Each Cluster

```bash
# Anthropic API key
oc create secret generic tcs-agentic-ai-secrets \
  --namespace=openshift-tcs-agentic \
  --from-literal=ANTHROPIC_API_KEY=your-key-here \
  --from-literal=SERVICENOW_INSTANCE=your-instance.service-now.com \
  --from-literal=SERVICENOW_USER=your-user \
  --from-literal=SERVICENOW_PASSWORD=your-password \
  --from-literal=MCP_API_TOKEN=your-mcp-token

# Or use a YAML file for consistency:
cat <<'EOF' | oc apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: tcs-agentic-ai-secrets
  namespace: openshift-tcs-agentic
type: Opaque
stringData:
  ANTHROPIC_API_KEY: "your-key-here"
  SERVICENOW_INSTANCE: "your-instance.service-now.com"
  SERVICENOW_USER: "your-user"
  SERVICENOW_PASSWORD: "your-password"
  MCP_API_TOKEN: "your-mcp-token"
EOF
```

---

## Step 4: Deploy MCP Server on Each Cluster

```yaml
# deploy/deployment.yaml — SAME file for ALL clusters
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tcs-agentic-ai
  namespace: openshift-tcs-agentic
  labels:
    app: tcs-agentic-ai
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tcs-agentic-ai
  template:
    metadata:
      labels:
        app: tcs-agentic-ai
    spec:
      serviceAccountName: tcs-agentic-ai
      containers:
      - name: mcp-server
        image: your-registry/tcs-agentic-ai:latest
        ports:
        - containerPort: 3001
          name: http
        envFrom:
        - secretRef:
            name: tcs-agentic-ai-secrets
        env:
        - name: PORT
          value: "3001"
        - name: NODE_ENV
          value: "production"
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 512Mi
        livenessProbe:
          httpGet:
            path: /api/health
            port: 3001
          initialDelaySeconds: 15
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /api/health
            port: 3001
          initialDelaySeconds: 5
          periodSeconds: 10
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: tcs-agentic-ai
  namespace: openshift-tcs-agentic
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: tcs-agentic-ai-view
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-reader
subjects:
- kind: ServiceAccount
  name: tcs-agentic-ai
  namespace: openshift-tcs-agentic
---
apiVersion: v1
kind: Service
metadata:
  name: tcs-agentic-ai
  namespace: openshift-tcs-agentic
spec:
  selector:
    app: tcs-agentic-ai
  ports:
  - port: 3001
    targetPort: 3001
    name: http
  type: ClusterIP
```

Apply on each cluster:
```bash
oc apply -f deploy/deployment.yaml
```

---

## Step 5: Expose the Service (per cluster)

### OpenShift Route
```bash
oc create route edge tcs-agentic-ai \
  --service=tcs-agentic-ai \
  --namespace=openshift-tcs-agentic \
  --port=3001
```

### Kubernetes Ingress
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tcs-agentic-ai
  namespace: tcs-agentic-system
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  rules:
  - host: tcs-agentic.your-cluster-domain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: tcs-agentic-ai
            port:
              number: 3001
```

---

## Step 6: Cluster Registry Configuration

On the hub/dashboard cluster, create a ConfigMap that lists all cluster MCP server endpoints:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tcs-cluster-registry
  namespace: openshift-tcs-agentic
data:
  clusters.json: |
    {
      "clusters": [
        {
          "name": "hub-cluster",
          "url": "https://tcs-agentic-ai-openshift-tcs-agentic.apps.hub.example.com",
          "role": "hub"
        },
        {
          "name": "prod-us-east",
          "url": "https://tcs-agentic-ai-openshift-tcs-agentic.apps.prod-us.example.com",
          "role": "spoke"
        },
        {
          "name": "prod-eu-west",
          "url": "https://tcs-agentic-ai-openshift-tcs-agentic.apps.prod-eu.example.com",
          "role": "spoke"
        }
      ]
    }
```

---

## Step 7: Automation Script — Deploy to All Clusters

Save this as `deploy/deploy-all.sh`:

```bash
#!/bin/bash
set -euo pipefail

IMAGE="your-registry/tcs-agentic-ai:latest"
NAMESPACE="openshift-tcs-agentic"
DEPLOY_DIR="$(dirname "$0")"

# List of cluster contexts (from your kubeconfig)
CLUSTERS=(
  "hub-cluster"
  "prod-us-east"
  "prod-eu-west"
  "staging"
  # Add more clusters here
)

echo "=== TCS Agentic AI — Multi-Cluster Deployment ==="
echo "Image: $IMAGE"
echo "Namespace: $NAMESPACE"
echo "Clusters: ${CLUSTERS[*]}"
echo ""

# Step 1: Build and push image
echo "[1/4] Building and pushing image..."
docker build -t "$IMAGE" .
docker push "$IMAGE"
echo "  ✓ Image pushed"

# Step 2: Deploy to each cluster
echo "[2/4] Deploying to clusters..."
for ctx in "${CLUSTERS[@]}"; do
  echo "  → Deploying to $ctx..."
  
  # Switch context
  oc config use-context "$ctx" 2>/dev/null || kubectl config use-context "$ctx"
  
  # Create namespace if it doesn't exist
  oc get namespace "$NAMESPACE" &>/dev/null || oc new-project "$NAMESPACE" || true
  
  # Apply deployment
  oc apply -f "$DEPLOY_DIR/deployment.yaml" -n "$NAMESPACE"
  
  # Update image
  oc set image deployment/tcs-agentic-ai \
    mcp-server="$IMAGE" \
    -n "$NAMESPACE"
  
  echo "  ✓ $ctx deployed"
done

# Step 3: Wait for rollouts
echo "[3/4] Waiting for rollouts..."
for ctx in "${CLUSTERS[@]}"; do
  oc config use-context "$ctx" 2>/dev/null || kubectl config use-context "$ctx"
  oc rollout status deployment/tcs-agentic-ai -n "$NAMESPACE" --timeout=120s
  echo "  ✓ $ctx ready"
done

# Step 4: Verify health
echo "[4/4] Verifying health endpoints..."
for ctx in "${CLUSTERS[@]}"; do
  oc config use-context "$ctx" 2>/dev/null || kubectl config use-context "$ctx"
  ROUTE=$(oc get route tcs-agentic-ai -n "$NAMESPACE" -o jsonpath='{.spec.host}' 2>/dev/null || echo "")
  if [ -n "$ROUTE" ]; then
    STATUS=$(curl -sk -o /dev/null -w "%{http_code}" "https://$ROUTE/api/health" || echo "000")
    if [ "$STATUS" = "200" ]; then
      echo "  ✓ $ctx health check passed (https://$ROUTE)"
    else
      echo "  ✗ $ctx health check failed (HTTP $STATUS)"
    fi
  else
    echo "  ⚠ $ctx no route found — check ingress/route configuration"
  fi
done

echo ""
echo "=== Deployment Complete ==="
```

Make it executable:
```bash
chmod +x deploy/deploy-all.sh
```

---

## Step 8: Rolling Update (for future changes)

```bash
# Update image on all clusters
./deploy/deploy-all.sh

# Or update a single cluster:
oc config use-context prod-us-east
oc set image deployment/tcs-agentic-ai \
  mcp-server=your-registry/tcs-agentic-ai:v2.0 \
  -n openshift-tcs-agentic
oc rollout status deployment/tcs-agentic-ai -n openshift-tcs-agentic
```

---

## Revert Instructions

### Option A: Revert to Previous Container Image
```bash
# Rollback deployment on a single cluster
oc rollout undo deployment/tcs-agentic-ai -n openshift-tcs-agentic

# Rollback on ALL clusters
for ctx in hub-cluster prod-us-east prod-eu-west staging; do
  oc config use-context "$ctx"
  oc rollout undo deployment/tcs-agentic-ai -n openshift-tcs-agentic
  echo "Reverted $ctx"
done
```

### Option B: Revert Code to Pre-Design-System
```bash
# In the git repository
git tag -l  # lists available tags — look for pre-design-system

# Checkout old code
git checkout pre-design-system -- dashboard-react/src/
git checkout pre-design-system -- CLAUDE.md

# Commit the revert
git commit -m "Revert to pre-design-system state"

# Rebuild and deploy
docker build -t your-registry/tcs-agentic-ai:reverted .
docker push your-registry/tcs-agentic-ai:reverted
./deploy/deploy-all.sh  # deploys the reverted version to all clusters
```

### Option C: Full Git Revert
```bash
# Reset to exact pre-design-system state
git reset --hard pre-design-system
git push -u origin claude/setup-mcp-openshift-9JUo7 --force-with-lease
```

---

## Validation Checklist

After deployment, verify on EACH cluster:

- [ ] `curl https://<route>/api/health` returns 200
- [ ] Login page loads with TCS Agentic AI branding
- [ ] Cluster strip shows all registered clusters
- [ ] Left navigation shows all 7 items
- [ ] AI Chat bar is visible at bottom of every page
- [ ] Dashboard widgets load with live data
- [ ] Observe view shows pod health
- [ ] Operate view shows fix proposals
- [ ] Tickets view shows ServiceNow incidents (if configured)
- [ ] Upgrade view shows cluster version
- [ ] Audit view loads compliance data
- [ ] Theme toggle (dark/light) works
- [ ] Command palette (Ctrl+K) opens
- [ ] Cluster switching updates all views

---

## Troubleshooting

| Issue | Cause | Fix |
|---|---|---|
| Pod CrashLoopBackOff | Missing secrets | Check `oc get secret tcs-agentic-ai-secrets` |
| 401 on API calls | Token expired | Recreate secret with new MCP_API_TOKEN |
| No data in dashboard | ClusterRole missing | Apply ClusterRoleBinding for cluster-reader |
| Route not accessible | TLS certificate | Check route edge termination settings |
| ServiceNow errors | PDI credentials | Verify SERVICENOW_* environment variables |
| AI responses empty | API key invalid | Check ANTHROPIC_API_KEY in secret |
