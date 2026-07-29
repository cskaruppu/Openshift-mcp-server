# SOP-033: Node Maintenance (Drain & Cordon)

**Purpose:** Safely take a worker node out of service for maintenance.
**Scope:** All clusters.
**Owner:** Infrastructure Team
**Risk:** High (drains workloads off the node)

## Steps

1. Cordon the node `<node>` so no new pods are scheduled on it.
2. Drain the node `<node>`, ignoring DaemonSets and deleting emptyDir data, to evict running workloads gracefully.
3. Verify all evictable pods have been rescheduled onto other nodes and the node shows SchedulingDisabled.
4. Raise a ServiceNow Change Request for the maintenance window with the node name and reason.

> Note: After physical maintenance, a follow-up SOP uncordons the node to return it to service.
