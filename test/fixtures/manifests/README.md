# Use Case 1 — End-to-End Validation Fixtures

These manifests deliberately create broken workloads so you can validate the full
**Chat → Diagnose → Fix → Ticket → Notify → Auto-Close** pipeline on a real cluster.

## Prerequisites

1. ServiceNow configured in dashboard Settings (SERVICENOW_INSTANCE / USERNAME / PASSWORD)
   — required for the Ticket + Auto-Close steps.
2. (Optional) Slack/Teams/PagerDuty configured for the Notify step.
3. `metrics.k8s.io` available (metrics-server / OpenShift monitoring) for smart memory sizing.

## Test Matrix

| Fixture | Failure | Chat phrase | Expected severity | Validates |
|---|---|---|---|---|
| `01-oomkill-test.yaml` | OOMKilled | `oomtest pod is crashing` | SEV-2 | Smart memory (metrics × 1.5), INC create, auto-close |
| `02-crashloop-test.yaml` | CrashLoopBackOff | `crashtest pod is crashing` | SEV-2 | Deep log analysis (FATAL/OOM/ECONNREFUSED patterns), restart fix |
| `03-imagepull-statefulset-test.yaml` | ImagePullBackOff | `pulltest pod is failing` | SEV-3 | **SEV-3 INC creation** + **StatefulSet** workload support |

## Step-by-Step Validation

### 1. Deploy a fixture
```bash
oc apply -f test/fixtures/manifests/01-oomkill-test.yaml
# Wait ~30s for the pod to reach OOMKilled / CrashLoopBackOff
oc get pods -n e2e-oomkill-test -w
```

### 2. CHAT + DIAGNOSE
In the dashboard chat, type the phrase from the table (e.g. `oomtest pod is crashing`).
- ✅ Auto-resolves namespace `e2e-oomkill-test` (you did NOT type the namespace)
- ✅ Diagnoses the SPECIFIC pod (not random pods)
- ✅ Shows Root Cause Analysis table
- ✅ Shows Log Analysis panel with detected error patterns

### 3. FIX
- ✅ Fix Proposal card shows a smart memory recommendation (based on actual usage, not a blind 2×)
- ✅ Command targets the correct workload kind (deployment/ or statefulset/)

### 4. TICKET
- ✅ "ServiceNow Incident | Auto-created | **INCxxxxxxx**" in the Escalation table
- ✅ Open the INC in ServiceNow — description has Severity, Root Cause, Recommended Fix

### 5. NOTIFY
- ✅ "Team Notification | Sent" (if Slack/Teams/PagerDuty configured)

### 6. AUTO-CLOSE
In the Fix Proposal card:
1. Click **▷ Dry Run** → preview only, nothing changes
2. Click **▶ Apply & Close INC** → applies the fix on the cluster
3. Backend waits for rollout to stabilize (replicas ready), then resolves the INC
4. ✅ Card shows "INCxxxxxxx resolved"
5. ✅ In ServiceNow the INC is **Resolved** with structured ITIL work notes:
   RCA, Log Analysis, Fix Applied, Verification, Prevention Recommendations

### 7. Cleanup
```bash
oc delete namespace e2e-oomkill-test e2e-crashloop-test e2e-imagepull-test
```

## Multi-Cluster Validation
Select a remote/spoke cluster in the dashboard, deploy a fixture there, and repeat.
All API calls route through the remote agent bridge — the same flow works unchanged.

## Backend-only (no UI) smoke test
```bash
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"oomtest pod is crashing","stream":false}' | jq -r '.reply'
```
Look for the `@@FIX_PROPOSAL|{...}@@` marker and the INC number in the reply.
