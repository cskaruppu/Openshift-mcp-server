# Agent Catalog

Every agent this platform exposes, with the endpoint to reach it and the tools it carries.
**Generated from `src/agents/manifests/` — do not edit by hand.** Re-run
`node docs/generate-agent-catalog.js --base https://your-host` after changing an agent.

**15 agents · 177 tools.**

## How to connect

Each agent is a separate MCP server over SSE. Two URLs per agent:

| | |
|---|---|
| **Connect** | `GET  https://<your-host>/mcp/<agent-id>/sse` |
| **Reply** | `POST https://<your-host>/mcp/<agent-id>/message?sessionId=<id>` |

The SSE stream issues the `sessionId`; the MCP client library handles that handshake.
**Connecting to the bare `/mcp/<agent-id>` returns 404** — the transport lives on `/sse`.

### Discovery

| Endpoint | Returns |
|---|---|
| `GET https://<your-host>/.well-known/agent.json` | A2A agent card — every agent with its connectable URLs |
| `GET https://<your-host>/api/agents` | All agents, with tool counts |
| `GET https://<your-host>/api/agents/<id>` | One agent, including `mcpSseUrl` and `mcpMessageUrl` |
| `GET https://<your-host>/api/agents/<id>/tools` | Just that agent's tool names |
| `GET https://<your-host>/api/agents/categories` | Agents grouped by category |
| `GET https://<your-host>/openapi.yaml` | REST surface, for non-MCP clients |

### Authentication

When `AUTH_MODE=token`, pass the bearer token on every request:

```
Authorization: Bearer $MCP_API_TOKEN
```

The whole registry is also reachable as a single MCP server at `https://<your-host>/sse`,
carrying all 177 tools. Prefer a **specific agent** — a focused tool list
measurably improves tool selection, and keeps an unrelated agent's tools out of the model's
context.

## Index

| Agent | ID | Tools | Category | Connect to |
|---|---|---|---|---|
| **Multi-Cluster & ACM Agent** | `multi-cluster-acm` | 6 | Governance | `/mcp/multi-cluster-acm/sse` |
| **Security & Compliance Agent** | `security-compliance` | 16 | Governance | `/mcp/security-compliance/sse` |
| **Application Change Intelligence Agent** | `application-change-intelligence` | 5 | Intelligence | `/mcp/application-change-intelligence/sse` |
| **Proactive Intelligence Agent** | `proactive-intelligence` | 21 | Intelligence | `/mcp/proactive-intelligence/sse` |
| **Backup & Disaster Recovery Agent** | `backup-dr` | 10 | Lifecycle | `/mcp/backup-dr/sse` |
| **ITSM & Change Management Agent** | `itsm-change-management` | 5 | Lifecycle | `/mcp/itsm-change-management/sse` |
| **Upgrade & Lifecycle Agent** | `upgrade-lifecycle` | 3 | Lifecycle | `/mcp/upgrade-lifecycle/sse` |
| **VM Lifecycle Agent** | `vm-lifecycle` | 10 | Lifecycle | `/mcp/vm-lifecycle/sse` |
| **Cluster Operations Agent** | `cluster-operations` | 20 | Operations | `/mcp/cluster-operations/sse` |
| **Diagnostics & Healing Agent** | `diagnostics-healing` | 10 | Operations | `/mcp/diagnostics-healing/sse` |
| **Workload Management Agent** | `workload-management` | 27 | Operations | `/mcp/workload-management/sse` |
| **Automation & Ansible Agent** | `automation-ansible` | 6 | Platform | `/mcp/automation-ansible/sse` |
| **CI/CD & GitOps Agent** | `cicd-gitops` | 15 | Platform | `/mcp/cicd-gitops/sse` |
| **Networking & Service Mesh Agent** | `networking-mesh` | 14 | Platform | `/mcp/networking-mesh/sse` |
| **Observability & Monitoring Agent** | `observability` | 9 | Platform | `/mcp/observability/sse` |

## Governance

### Multi-Cluster & ACM Agent

`multi-cluster-acm` · v1.0.0 · 6 tools

Red Hat Advanced Cluster Management (ACM) for managed clusters, governance policies, federated search, and emergency cross-cluster response.

```
SSE      https://<your-host>/mcp/multi-cluster-acm/sse
MESSAGE  https://<your-host>/mcp/multi-cluster-acm/message
```

**Capabilities**

- ACM ManagedCluster inventory across hub and spokes
- Per-cluster detail with health, version, capacity
- ACM governance policy listing and compliance state
- Federated search across all managed clusters
- Emergency fix with two-person approval rule
- Approved emergency action execution with audit trail

<details><summary>6 tools</summary>

- `list_managed_clusters`
- `get_managed_cluster_details`
- `list_acm_policies`
- `search_across_clusters`
- `emergency_fix`
- `approved_fix`

</details>

*Tags: `acm` · `multi-cluster` · `fleet` · `governance` · `emergency`*

### Security & Compliance Agent

`security-compliance` · v1.0.0 · 16 tools

RBAC audit, Pod Security Standards, network policy audit, image scanning, secret rotation analysis, SCC advisor, compliance scanning, and policy generation.

```
SSE      https://<your-host>/mcp/security-compliance/sse
MESSAGE  https://<your-host>/mcp/security-compliance/message
```

**Capabilities**

- RBAC audit across ClusterRoles and RoleBindings
- Reverse RBAC: 'who can do X on resource Y'
- Pod Security Standards compliance check (privileged, hostPath, root)
- Network policy gap analysis (namespaces without isolation)
- Container image audit (latest tags, registry, signature)
- Secret rotation and exposure analysis
- OpenSCAP compliance scoring and reports
- SCC (Security Context Constraints) explainer and audit
- Auto-generation of NetworkPolicies, SCCs, and Pod policies
- Read-only and disable-destructive safety modes
- Container image vulnerability scanning, reporting and compliance checks

<details><summary>16 tools</summary>

- `security_rbac_audit`
- `security_rbac_who_can`
- `security_pod_security_audit`
- `security_network_policy_audit`
- `security_image_audit`
- `security_secret_audit`
- `security_compliance_score`
- `compliance_check`
- `scc_explain`
- `scc_audit`
- `generate_policy`
- `generate_networkpolicy`
- `generate_scc`
- `image_vuln_scan`
- `image_vuln_report`
- `image_compliance_check`

</details>

*Tags: `security` · `rbac` · `compliance` · `scc` · `policy`*

## Intelligence

### Application Change Intelligence Agent

`application-change-intelligence` · v1.0.0 · 5 tools

Watches application workloads for change, detects GitOps drift between desired and live state, keeps a change history, and can roll a change back.

```
SSE      https://<your-host>/mcp/application-change-intelligence/sse
MESSAGE  https://<your-host>/mcp/application-change-intelligence/message
```

**Capabilities**

- Watch selected namespaces for application change
- Scan for changes to workloads since a baseline
- GitOps drift detection between Git desired state and live cluster
- Per-application change history
- Roll back a detected change

<details><summary>5 tools</summary>

- `app_watch_namespaces`
- `app_change_scan`
- `app_change_history`
- `app_gitops_drift`
- `app_change_rollback`

</details>

*Tags: `drift` · `gitops` · `change` · `history` · `rollback` · `application`*

### Proactive Intelligence Agent

`proactive-intelligence` · v1.0.0 · 21 tools

Autonomous background monitoring, anomaly detection, predictive trend analysis, cost / right-sizing recommendations, drift detection, impact prediction, benchmarks, and natural language automation rules.

```
SSE      https://<your-host>/mcp/proactive-intelligence/sse
MESSAGE  https://<your-host>/mcp/proactive-intelligence/message
```

**Capabilities**

- Background autonomous cluster scanning at configurable intervals
- Anomaly detection (restart spikes, new CrashLoops, resource pressure)
- Predictive trend forecasting (OOM, disk-full, capacity exhaustion)
- Cost and right-sizing recommendations from Prometheus + requests
- Drift detection between desired and actual state
- Impact prediction for proposed changes
- Cluster benchmarks (kube-burner, storage, network, CPU, database)
- Multi-channel notifications (Dashboard, Slack, PagerDuty, Email, ServiceNow)
- Incident timeline reconstruction
- Natural-language automation rules engine

<details><summary>21 tools</summary>

- `notify_send`
- `notify_alerts`
- `notify_health_report`
- `notify_test`
- `notify_pagerduty_resolve`
- `notify_channels_status`
- `incident_timeline`
- `predict_impact`
- `drift_detect`
- `run_kube_burner`
- `run_storage_benchmark`
- `run_network_test`
- `run_cpu_stress_test`
- `run_database_benchmark`
- `recommend_resource_rightsizing`
- `recommend_capacity_planning`
- `recommend_pod_disruption`
- `recommend_health_trends`
- `recommend_topology_spread`
- `recommend_quota_optimization`
- `recommend_cluster_summary`

</details>

*Tags: `proactive` · `predictive` · `anomaly` · `cost` · `automation` · `ml`*

## Lifecycle

### Backup & Disaster Recovery Agent

`backup-dr` · v1.0.0 · 10 tools

Velero-based backup and restore for OpenShift — backup and schedule management, restore, storage location and Data Protection Application status, and DR readiness assessment.

```
SSE      https://<your-host>/mcp/backup-dr/sse
MESSAGE  https://<your-host>/mcp/backup-dr/message
```

**Capabilities**

- Create, list, inspect and delete Velero backups
- Restore from a backup
- Backup schedules and backup storage locations
- Data Protection Application (DPA) status
- Disaster Recovery readiness assessment

<details><summary>10 tools</summary>

- `velero_dr_readiness`
- `velero_list_backups`
- `velero_get_backup`
- `velero_create_backup`
- `velero_delete_backup`
- `velero_list_schedules`
- `velero_list_restores`
- `velero_create_restore`
- `velero_storage_locations`
- `velero_dpa_status`

</details>

*Tags: `velero` · `backup` · `restore` · `dr` · `oadp` · `data-protection`*

### ITSM & Change Management Agent

`itsm-change-management` · v1.0.0 · 5 tools

ServiceNow integration for change request lifecycle, incident creation, approval polling, and audit-ready execution of approved changes.

```
SSE      https://<your-host>/mcp/itsm-change-management/sse
MESSAGE  https://<your-host>/mcp/itsm-change-management/message
```

**Capabilities**

- Auto-create ServiceNow change requests for upgrades and remediations
- Auto-create ServiceNow incidents from proactive alerts
- Periodic approval status polling with proactive notifications
- ITIL-aligned change lifecycle (submitted → approved → scheduled → executed)
- Auto-cancel CRs deleted from ServiceNow (404 handling)
- HTML pre-assessment report attachment to CRs
- Pending CR panel with dismiss, sync-all, last-synced indicator
- ServiceNow record query and update via natural language

<details><summary>5 tools</summary>

- `create_servicenow_incident`
- `create_change_request`
- `check_approval_status`
- `query_servicenow`
- `update_servicenow_record`

</details>

*Tags: `servicenow` · `itsm` · `change-request` · `approval` · `itil`*

### Upgrade & Lifecycle Agent

`upgrade-lifecycle` · v1.0.0 · 3 tools

22-point pre-upgrade cluster assessment with version comparison, channel validation, operator compatibility, certificate expiry, deprecated API detection, and node topology analysis.

```
SSE      https://<your-host>/mcp/upgrade-lifecycle/sse
MESSAGE  https://<your-host>/mcp/upgrade-lifecycle/message
```

**Capabilities**

- 22-point industry-standard pre-upgrade assessment
- Side-by-side current vs target version comparison (OCP, Kubernetes, CRI-O, RHEL)
- Upgrade path validation against channel availability
- Cluster operator readiness check (Available / Degraded / Progressing)
- OLM operator compatibility (maxOpenShiftVersion, minKubeVersion, channel alignment)
- Certificate expiry detection (90-day window)
- Deprecated and removed API detection across version skew
- Node topology analysis with upgrade duration estimation
- Feature highlights summary across version delta

<details><summary>3 tools</summary>

- `upgrade_preflight_check`
- `upgrade_readiness`
- `certificate_check`

</details>

*Tags: `upgrade` · `preflight` · `lifecycle` · `version` · `compatibility`*

### VM Lifecycle Agent

`vm-lifecycle` · v1.0.0 · 10 tools

OpenShift Virtualization (KubeVirt) virtual machine provisioning and lifecycle. Provisions VMs with persistent DataVolume-backed disks, cloud-init access, golden-image sources and instance types, with server-side dry-run and provenance labelling for day-2 ownership.

```
SSE      https://<your-host>/mcp/vm-lifecycle/sse
MESSAGE  https://<your-host>/mcp/vm-lifecycle/message
```

**Capabilities**

- Discover what is provisionable: golden image DataSources, cluster instance types, guest preferences
- Provision VMs with a PERSISTENT DataVolume root disk (not ephemeral containerDisk)
- cloud-init user, SSH key, hostname injection so the VM is reachable on first boot
- Golden sizing via VirtualMachineClusterInstancetype and Preference
- Bridge/VLAN attachment via NetworkAttachmentDefinition, or pod networking
- Server-side dry-run (dryRun=All) before any VM is created
- Provenance labelling: owner, cost centre, environment, request ID, expiry, sizing rationale
- VM lifecycle: start, stop, restart, inspect running instances
- Fleet inventory of every VM the platform provisioned, with its provenance
- Expiry enforcement: VMs past their recorded decommission date, with a decommission change request
- Right-sizing: VMs whose observed usage no longer matches the size chosen at provisioning, referencing the original request
- Access guidance: cloud-init user, IP addresses, guest agent state and the exact virtctl/ssh commands
- Approval-gated provisioning: submit to ServiceNow, provision automatically once the change is approved

<details><summary>10 tools</summary>

- `kubevirt_list_templates`
- `kubevirt_create_vm`
- `kubevirt_lifecycle_report`
- `kubevirt_vm_access`
- `kubevirt_list_vms`
- `kubevirt_get_vm`
- `kubevirt_start_vm`
- `kubevirt_stop_vm`
- `kubevirt_restart_vm`
- `kubevirt_list_vmis`

</details>

*Tags: `kubevirt` · `openshift-virtualization` · `vm` · `provisioning` · `cnv` · `datavolume` · `cloud-init`*

## Operations

### Cluster Operations Agent

`cluster-operations` · v1.0.0 · 20 tools

Cluster-wide operations including cluster info, node health, namespace management, and generic Kubernetes resource operations.

```
SSE      https://<your-host>/mcp/cluster-operations/sse
MESSAGE  https://<your-host>/mcp/cluster-operations/message
```

**Capabilities**

- Cluster-level inventory and health visibility
- Node health, kubelet & CRI-O status, log retrieval
- Namespace listing and detail inspection
- Generic Kubernetes resource CRUD operations
- Cluster events and resource utilisation
- Multi-cluster context listing and switching

<details><summary>20 tools</summary>

- `get_cluster_info`
- `get_cluster_events`
- `get_cluster_resource_usage`
- `list_nodes`
- `get_node_details`
- `nodes_log`
- `check_kubelet_status`
- `check_crio_status`
- `nodes_stats_summary`
- `list_namespaces`
- `get_namespace_details`
- `generic_get`
- `generic_list`
- `generic_create`
- `generic_delete`
- `generic_scale`
- `generic_apply`
- `cluster_list_contexts`
- `cluster_get_active_context`
- `cluster_switch_context`

</details>

*Tags: `cluster` · `node` · `namespace` · `kubernetes`*

### Diagnostics & Healing Agent

`diagnostics-healing` · v1.0.0 · 10 tools

Root cause analysis with exit code mapping, log pattern matching across 15+ failure signatures, automated fix proposals with approval gates, curated remediation playbooks, and must-gather collection for Red Hat support.

```
SSE      https://<your-host>/mcp/diagnostics-healing/sse
MESSAGE  https://<your-host>/mcp/diagnostics-healing/message
```

**Capabilities**

- Pod root cause analysis with deep exit code mapping (0, 1, 2, 126, 127, 137, 139)
- Log pattern matching for OOMKilled, CrashLoopBackOff, ImagePullBackOff, ConfigError, BadFlag, MissingArg, PortConflict, ParseError
- Curated remediation playbooks for known failure signatures
- Automated fix proposals routed through approval workflow
- Cross-incident learning — matches new issues to historical resolutions
- Must-gather collection for Red Hat case attachment
- Operator health and upgrade compatibility diagnostics

<details><summary>10 tools</summary>

- `diagnose_pod_issues`
- `diagnose_namespace_health`
- `cluster_health_check`
- `operator_health`
- `operator_upgrade_check`
- `mustgather_cluster_snapshot`
- `mustgather_namespace_dump`
- `mustgather_etcd_health`
- `mustgather_certificate_check`
- `mustgather_resource_quotas`

</details>

*Tags: `diagnostics` · `rca` · `healing` · `must-gather` · `playbooks`*

### Workload Management Agent

`workload-management` · v1.0.0 · 27 tools

Workload lifecycle management for pods, deployments, StatefulSets, DaemonSets, services, routes, Helm releases, and provisioning of new workloads.

```
SSE      https://<your-host>/mcp/workload-management/sse
MESSAGE  https://<your-host>/mcp/workload-management/message
```

**Capabilities**

- Pod lifecycle: list, describe, logs, exec, run, delete
- Deployments / StatefulSets / DaemonSets management
- Scale & restart deployments with approval gating
- Services, Routes, PVCs, ConfigMaps, Secrets inventory
- Helm release install / upgrade / uninstall / history
- Provision new workloads (deployments, databases, HPAs, services)
- Document-driven deployment: parse a requirements document, generate manifests, preview, deploy and roll back

<details><summary>27 tools</summary>

- `list_pods`
- `get_pod_details`
- `get_pod_logs`
- `pods_exec`
- `pods_run`
- `delete_pod`
- `list_deployments`
- `list_statefulsets`
- `list_daemonsets`
- `scale_deployment`
- `restart_deployment`
- `list_services`
- `list_routes`
- `list_pvcs`
- `list_configmaps`
- `list_secrets`
- `helm_list`
- `helm_install`
- `helm_uninstall`
- `helm_status`
- `helm_history`
- `create_deployment`
- `deploy_database`
- `create_hpa`
- `create_service`
- `create_network_policy`
- `deploy_from_document`

</details>

*Tags: `pods` · `deployments` · `helm` · `workloads` · `provisioning`*

## Platform

### Automation & Ansible Agent

`automation-ansible` · v1.0.0 · 6 tools

Ansible Automation Platform integration — launch job templates and workflows, track job status, and inspect inventories from the platform.

```
SSE      https://<your-host>/mcp/automation-ansible/sse
MESSAGE  https://<your-host>/mcp/automation-ansible/message
```

**Capabilities**

- Discover Ansible job templates and workflows
- Launch a job template with extra variables
- Launch a workflow job template
- Poll job status to completion
- Inspect inventories

<details><summary>6 tools</summary>

- `list_ansible_job_templates`
- `launch_ansible_job`
- `check_ansible_job_status`
- `list_ansible_inventories`
- `list_ansible_workflows`
- `launch_ansible_workflow`

</details>

*Tags: `ansible` · `aap` · `automation` · `job-template` · `workflow`*

### CI/CD & GitOps Agent

`cicd-gitops` · v1.0.0 · 15 tools

Tekton pipelines and tasks management, ArgoCD applications, GitOps sync, drift remediation, and pipeline run history.

```
SSE      https://<your-host>/mcp/cicd-gitops/sse
MESSAGE  https://<your-host>/mcp/cicd-gitops/message
```

**Capabilities**

- Tekton pipeline and task inventory
- Start, restart, and inspect pipeline runs
- TaskRun log streaming and analysis
- ArgoCD Application listing and sync
- Application drift detection (live vs desired state)
- GitOps rollback to last healthy revision
- AppProject inventory and policy

<details><summary>15 tools</summary>

- `tekton_list_pipelines`
- `tekton_list_pipelineruns`
- `tekton_get_pipelinerun`
- `tekton_start_pipeline`
- `tekton_list_tasks`
- `tekton_pipelinerun_restart`
- `tekton_start_task`
- `tekton_taskrun_restart`
- `tekton_get_taskrun_logs`
- `gitops_list_applications`
- `gitops_get_application`
- `gitops_sync_application`
- `gitops_app_diff`
- `gitops_list_appprojects`
- `gitops_application_rollback`

</details>

*Tags: `tekton` · `argocd` · `gitops` · `pipelines` · `ci-cd`*

### Networking & Service Mesh Agent

`networking-mesh` · v1.0.0 · 14 tools

Network policies, routes, ingress, CoreDNS, service connectivity checks, and Istio / OpenShift Service Mesh management.

```
SSE      https://<your-host>/mcp/networking-mesh/sse
MESSAGE  https://<your-host>/mcp/networking-mesh/message
```

**Capabilities**

- Service endpoint reachability testing
- Routes and ingress inventory and detail inspection
- Network policy listing and gap analysis
- CoreDNS configuration inspection
- End-to-end service connectivity diagnostics
- Istio / OSSM mesh graph visualisation
- VirtualService, DestinationRule, Gateway management
- Mesh metrics, traces, and workload logs

<details><summary>14 tools</summary>

- `net_check_endpoints`
- `net_get_routes`
- `net_get_ingresses`
- `net_get_networkpolicies`
- `net_get_coredns_config`
- `net_check_service`
- `net_get_route_detail`
- `ossm_mesh_graph`
- `ossm_istio_config_read`
- `ossm_istio_config_write`
- `ossm_get_resource_details`
- `ossm_get_metrics`
- `ossm_get_traces`
- `ossm_workload_logs`

</details>

*Tags: `network` · `routes` · `ingress` · `istio` · `ossm` · `mesh`*

### Observability & Monitoring Agent

`observability` · v1.0.0 · 9 tools

Prometheus PromQL queries, Alertmanager firing alerts, top metrics for pods and nodes, and dashboard summary aggregation.

```
SSE      https://<your-host>/mcp/observability/sse
MESSAGE  https://<your-host>/mcp/observability/message
```

**Capabilities**

- Instant Prometheus PromQL queries
- Range Prometheus queries with step interval
- Alertmanager firing alerts query and routing
- Top CPU/memory pods with sorting and namespace filter
- Top CPU/memory nodes with sorting
- Aggregated dashboard summary (cluster, alerts, ops, OLM, recent CRs)
- GPU fleet inventory and DCGM telemetry: per-node model, allocation, driver version, MIG capability, utilisation and health

<details><summary>9 tools</summary>

- `prometheus_query`
- `prometheus_query_range`
- `alertmanager_query`
- `pods_top`
- `nodes_top`
- `get_dashboard_summary`
- `gpu_inventory`
- `gpu_overview`
- `gpu_stack_check`

</details>

*Tags: `prometheus` · `metrics` · `alerts` · `monitoring` · `observability`*

## Integrating

Every example below connects to **one** agent. Swap the id to reach another.

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "tcs-vm-lifecycle": {
      "url": "https://<your-host>/mcp/vm-lifecycle/sse",
      "headers": {
        "Authorization": "Bearer ${MCP_API_TOKEN}"
      }
    }
  }
}
```

### Python — MCP SDK

```python
from mcp import ClientSession
from mcp.client.sse import sse_client

URL = "https://<your-host>/mcp/vm-lifecycle/sse"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}

async with sse_client(URL, headers=HEADERS) as (read, write):
    async with ClientSession(read, write) as session:
        await session.initialize()
        tools = await session.list_tools()
        print([t.name for t in tools.tools])

        result = await session.call_tool("kubevirt_list_templates", {})
        print(result.content[0].text)
```

### LangChain / LangGraph

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({
    "vm_lifecycle": {
        "url": "https://<your-host>/mcp/vm-lifecycle/sse",
        "transport": "sse",
        "headers": {"Authorization": f"Bearer {TOKEN}"},
    },
    "rca": {
        "url": "https://<your-host>/mcp/diagnostics-healing/sse",
        "transport": "sse",
        "headers": {"Authorization": f"Bearer {TOKEN}"},
    },
})
tools = await client.get_tools()   # both agents, as LangChain tools
```

### Microsoft Agent Framework

See `adapters/microsoft-agent-framework/` for a working multi-agent orchestrator
against these endpoints.

### Plain REST — no MCP client

```bash
curl -s -H "Authorization: Bearer $MCP_API_TOKEN" \
  https://<your-host>/api/agents | jq '.agents[] | {id, name, toolCount}'

# what one agent can do
curl -s -H "Authorization: Bearer $MCP_API_TOKEN" \
  https://<your-host>/api/agents/vm-lifecycle/tools | jq
```

The REST surface in `openapi.yaml` covers the common operations without MCP at all —
useful for a system that only needs to read cluster state.

## Choosing an agent

| If you want to… | Use |
|---|---|
| Diagnose a failing workload | `diagnostics-healing` |
| Provision or own a VM | `vm-lifecycle` |
| Read cluster state and inventory | `cluster-operations` |
| Deploy or scale workloads | `workload-management` |
| Check compliance or image vulnerabilities | `security-compliance` |
| Backup and restore | `backup-dr` |
| Metrics, GPU fleet, SLOs | `observability` |
| Raise or track a change record | `itsm-change-management` |
| Predict risk or spot anomalies | `proactive-intelligence` |

---

*Generated 2026-08-14 from 15 manifests. Regenerate with* 
`node docs/generate-agent-catalog.js --base https://your-host`
