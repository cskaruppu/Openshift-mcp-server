# SOP-021: Remediate an OOMKilled Deployment

**Purpose:** Recover a workload that is being OOMKilled and prevent recurrence.
**Scope:** All clusters.
**Owner:** SRE On-Call
**Risk:** Medium (changes resource limits and restarts the workload)

## Steps

1. Verify the affected deployment `<deployment>` in namespace `<namespace>` is showing OOMKilled restarts.
2. Increase the memory limit of container `<container>` on deployment `<deployment>` to `<new-limit>` (1.5x current).
3. Restart the deployment `<deployment>` to roll out the new limit.
4. Verify the new pods are Running and Ready, with zero OOMKilled events after the rollout.
5. Raise a ServiceNow Change Request recording the memory increase and the before/after pod health.
