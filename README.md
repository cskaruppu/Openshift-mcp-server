# TCS Agentic AI — OpenShift Intelligence Platform

A production-grade **Model Context Protocol (MCP)** server for **Red Hat OpenShift Container Platform** with hub/spoke multi-cluster federation, AI-powered diagnostics, **Advanced Cluster Management (ACM)** integration, **Ansible Automation Platform** remediation, and **ServiceNow ITSM** workflows.

Deployable on any number of OpenShift/Kubernetes clusters using the same container image. A centralized React dashboard provides unified management across all clusters.

---

## Architecture

TCS Agentic AI follows the **hub/spoke federation pattern** used by Red Hat ACM, Rancher, ArgoCD, and Thanos. The same MCP server image runs on every cluster — the hub aggregates, the spokes execute locally.

```
                     ┌──────────────────────────────┐
                     │       AI Assistants           │
                     │  (Claude, ChatGPT, Copilot)   │
                     └──────────┬───────────────────┘
                                │ SSE / stdio / MCP
        ┌───────────────────────▼────────────────────────┐
        │                  Hub Cluster                    │
        │                                                │
        │  ┌──────────────┐    ┌──────────────────────┐  │
        │  │  Dashboard   │───▶│    MCP Server         │  │
        │  │  (React +    │/api│    (MCP_MODE=hub)     │  │
        │  │   Nginx)     │    │                       │  │
        │  │  Port 8080   │    │  • Federation proxy   │  │
        │  └──────────────┘    │  • Spoke registry     │  │
        │                      │  • Local cluster ops  │  │
        │  ┌────────┐         │  • AI Chat / NLU      │  │
        │  │Postgres│◀────────│  • Audit / History     │  │
        │  │ Redis  │         │  Port 3000             │  │
        │  └────────┘         └──────┬───────┬─────────┘  │
        └─────────────────────────────┼───────┼────────────┘
                                      │       │
                    ┌─────────────────┘       └──────────────────┐
                    │ proxy /api/*                proxy /api/*    │
        ┌───────────▼──────────────┐    ┌───────▼───────────────────┐
        │     Spoke Cluster A      │    │     Spoke Cluster B       │
        │                          │    │                           │
        │  ┌────────────────────┐  │    │  ┌─────────────────────┐  │
        │  │   MCP Server       │  │    │  │    MCP Server        │  │
        │  │  (MCP_MODE=spoke)  │  │    │  │   (MCP_MODE=spoke)  │  │
        │  │                    │  │    │  │                     │  │
        │  │  • Local queries   │  │    │  │  • Local queries    │  │
        │  │  • Same code path  │  │    │  │  • Same code path   │  │
        │  │  • Heartbeat→hub   │  │    │  │  • Heartbeat→hub    │  │
        │  └────────────────────┘  │    │  └─────────────────────┘  │
        └──────────────────────────┘    └───────────────────────────┘
```

### Why Hub/Spoke?

| Problem (Agent Bridge)                     | Solution (Hub/Spoke)                          |
|--------------------------------------------|-----------------------------------------------|
| Agent on spoke runs different code path    | Same MCP server image on every cluster        |
| Secondary clusters return different results | Local execution = identical results           |
| Bridge caches stale data                   | Hub proxies live API requests to spoke        |
| Scaling requires new agent per cluster     | Deploy same image, auto-registers with hub    |

### How It Works

1. **Hub** runs the MCP server with `MCP_MODE=hub` plus the React dashboard as a separate pod
2. **Spokes** run the same MCP server image with `MCP_MODE=spoke` — they auto-register with the hub via `POST /api/spoke/register` and send periodic heartbeats
3. When a user queries a remote cluster (e.g., `?cluster=prod-east`), the hub **proxies the request** to the spoke's MCP server — the spoke executes the query locally and returns the result
4. The dashboard connects to the hub MCP server and manages all clusters through a single interface

---

## Features

### Cluster Insights & Information Gathering

| Tool | Description |
|------|-------------|
| `get_cluster_info` | Cluster version, channel, platform, operator status |
| `get_cluster_events` | Recent events filtered by namespace/type |
| `get_cluster_resource_usage` | CPU, memory, pod capacity across all nodes |
| `list_nodes` | All nodes with status, roles, capacity |
| `get_node_details` | Detailed node info with pods running on it |
| `list_pods` | Pods in namespace or cluster-wide |
| `get_pod_details` | Container statuses, events, resource requests |
| `get_pod_logs` | Container logs (tail, previous container) |
| `list_namespaces` | All namespaces/projects with quotas |
| `get_namespace_details` | Workloads, quotas, services in a namespace |

### Diagnostics & Issue Detection

| Tool | Description |
|------|-------------|
| `diagnose_pod_issues` | Detects CrashLoopBackOff, ImagePullBackOff, OOMKilled, scheduling failures with fix suggestions |
| `diagnose_namespace_health` | Health check on all workloads — failing pods, unavailable deployments, quota pressure |
| `cluster_health_check` | Comprehensive cluster assessment — nodes, operators, critical components |

### ServiceNow ITSM Integration

| Tool | Description |
|------|-------------|
| `create_servicenow_incident` | Create incident for detected issues |
| `create_change_request` | Create normal/standard/emergency change requests |
| `check_approval_status` | Check if a change request has been approved |
| `query_servicenow` | Query incidents, changes, problems |
| `update_servicenow_record` | Update records (close, add notes) |

### Ansible Automation Platform

| Tool | Description |
|------|-------------|
| `list_ansible_job_templates` | List available remediation playbooks |
| `launch_ansible_job` | Run a playbook with extra variables |
| `check_ansible_job_status` | Monitor running job status |
| `list_ansible_inventories` | List inventories |
| `list_ansible_workflows` | List workflow templates |
| `launch_ansible_workflow` | Launch multi-step workflows |

### Emergency Fixes

| Tool | Description |
|------|-------------|
| `emergency_fix` | Immediate fix with auto-created emergency change request and notification |
| `approved_fix` | Execute fix only after ITSM approval is confirmed |

Supported actions: `restart_pod`, `scale_deployment`, `cordon_node`, `drain_node`, `rollback_deployment`, `delete_stuck_pod`

### Multi-Cluster Management (ACM)

| Tool | Description |
|------|-------------|
| `list_managed_clusters` | All ACM managed clusters with health |
| `get_managed_cluster_details` | Detailed cluster info, claims, capacity |
| `list_acm_policies` | Governance policies and compliance |
| `search_across_clusters` | Search resources across all clusters |

### Advanced Tools

| Category | Tools |
|----------|-------|
| **Security** | SCC advisor, compliance scanner, image vulnerability scanner, policy engine |
| **Networking** | Network topology, OSSM (Service Mesh), network policy analysis |
| **Observability** | Prometheus queries, metrics-top, SLO tracker, Alertmanager |
| **GitOps** | Tekton pipelines, GitOps sync, Helm chart management |
| **Capacity** | Capacity forecasting, cost advisor, resource recommendations |
| **Workloads** | KubeVirt VMs, Velero backups, workload management, drift detection |
| **AI Intelligence** | Root cause analysis, predictive intelligence, incident RAG, learning engine |

### Dashboard

The React dashboard (`console/`) provides:

- **Cluster health metrics** — nodes, operators, version, resource utilization
- **AI Chat interface** — natural language queries via MCP protocol
- **Audit trail** — full history of actions and AI interactions
- **AI Intelligence** — predictive insights, recommendations, anomaly detection
- **Multi-cluster management** — manage hub and all spoke clusters from a single view
- **Emergency actions** — quick remediation buttons
- **ITSM workflow** — ServiceNow integration pipeline

---

## Prerequisites

- **OpenShift Container Platform** 4.12+ (or any Kubernetes 1.24+)
- **Node.js** 20+ (for local development)
- **Podman** or **Docker** (for container builds)
- **Red Hat ACM** (optional — for multi-cluster governance features)
- **Ansible Automation Platform** (optional — for playbook-based remediation)
- **ServiceNow** instance (optional — for ITSM integration)

---

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/cskaruppu/openshift-mcp-server.git
cd openshift-mcp-server
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Required — OpenShift
OPENSHIFT_API_URL=https://api.your-cluster.example.com:6443
OPENSHIFT_TOKEN=$(oc whoami -t)

# Optional — ServiceNow
SERVICENOW_INSTANCE=https://your-instance.service-now.com
SERVICENOW_USERNAME=admin
SERVICENOW_PASSWORD=your-password

# Optional — Ansible
ANSIBLE_CONTROLLER_URL=https://ansible-controller.apps.your-cluster.example.com
ANSIBLE_CONTROLLER_TOKEN=your-token

# Optional — Emergency webhook (Slack/Teams)
EMERGENCY_NOTIFICATION_WEBHOOK=https://hooks.slack.com/services/...

# Optional — PostgreSQL and Redis (hub mode)
POSTGRES_HOST=localhost
POSTGRES_DB=mcp
REDIS_URL=redis://localhost:6379
```

### 4. Run Locally

```bash
# Hub mode (default)
MCP_MODE=hub node src/index.js

# Spoke mode (connects to hub)
MCP_MODE=spoke HUB_URL=http://hub-host:3000 CLUSTER_NAME=my-spoke node src/index.js

# Dev mode with auto-reload
npm run dev
```

### 5. Connect to Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openshift": {
      "command": "node",
      "args": ["/path/to/openshift-mcp-server/src/index.js"],
      "env": {
        "OPENSHIFT_API_URL": "https://api.your-cluster.example.com:6443",
        "OPENSHIFT_TOKEN": "sha256~your-token",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

Or via **Claude Code CLI**:

```bash
claude mcp add openshift-mcp -- node /path/to/openshift-mcp-server/src/index.js
```

---

## Deployment

TCS Agentic AI ships as **two container images**:

| Image | Description | Deployed On |
|-------|-------------|-------------|
| **MCP Server** | Node.js API server — cluster operations, AI chat, federation | Hub + all spokes |
| **Dashboard** | React SPA + Nginx — reverse proxies `/api/*` to MCP server | Hub only |

### Deploy Hub Cluster

The hub deploy script builds both images, deploys the MCP server with PostgreSQL and Redis, and deploys the dashboard as a separate Nginx pod.

```bash
./deploy/hub/deploy.sh
```

What it does:
1. Builds the MCP server image (`Dockerfile`) and dashboard image (`console/Dockerfile`)
2. Creates the `openshift-mcp` namespace with RBAC
3. Deploys PostgreSQL + Redis (persistent storage for audit, chat history, knowledge base)
4. Deploys MCP server with `MCP_MODE=hub`
5. Deploys the dashboard (React + Nginx) as a separate pod
6. Creates an OpenShift Route pointing to the dashboard

After deployment:

```bash
# Get the dashboard URL
oc get route mcp-dashboard -n openshift-mcp -o jsonpath='{.spec.host}'

# Check pods
oc get pods -n openshift-mcp
# Expected: mcp-server, mcp-dashboard, postgres, redis
```

### Deploy Spoke Cluster

Run on each secondary cluster. Deploys only the MCP server (no dashboard, no databases).

```bash
./deploy/spoke/deploy.sh
```

What it does:
1. Builds the same MCP server image
2. Creates the `openshift-mcp` namespace with RBAC
3. Deploys MCP server with `MCP_MODE=spoke`
4. Auto-detects the spoke's external URL (from Route or Service)
5. Registers with the hub — sends `HUB_URL`, `CLUSTER_NAME`, and platform info

Environment variables set via ConfigMap:

| Variable | Description |
|----------|-------------|
| `MCP_MODE` | `spoke` |
| `HUB_URL` | URL of the hub MCP server (e.g., `https://mcp-server-hub.apps.hub-cluster.com`) |
| `CLUSTER_NAME` | Unique name for this spoke (e.g., `prod-east`, `staging-west`) |
| `CLUSTER_PLATFORM` | Platform type (auto-detected: `openshift` or `kubernetes`) |

### Adding a Spoke to the Hub

Spokes register automatically on startup. You can verify from the hub:

```bash
# Check registered spokes
curl https://<hub-url>/api/spoke/status

# Manual registration (if needed)
curl -X POST https://<hub-url>/api/spoke/register \
  -H "Content-Type: application/json" \
  -d '{"clusterName":"prod-east","spokeUrl":"https://mcp-spoke.apps.prod-east.com"}'
```

### Helm Chart

A Helm chart is available for advanced deployments:

```bash
helm install tcs-agentic-ai ./chart/openshift-mcp \
  --set mcpMode=hub \
  --set image.repository=quay.io/your-org/openshift-mcp-server \
  --set image.tag=latest
```

---

## ITSM Workflows

### Normal Flow (with Approval)
1. AI detects issue via diagnostic tools
2. Creates a **change request** in ServiceNow
3. Waits for manager approval
4. Once approved, executes fix via `approved_fix`
5. Updates ServiceNow ticket with resolution

### Emergency Flow
1. AI detects critical production issue
2. Calls `emergency_fix` — **immediately** creates emergency change request
3. Executes the fix right away
4. Sends webhook notification to ops team
5. Post-approval and review follows

### Ansible-Driven Flow
1. AI detects issue and creates ServiceNow ticket
2. After approval, launches Ansible playbook via `launch_ansible_job`
3. Monitors job via `check_ansible_job_status`
4. Updates ITSM ticket on completion

---

## Project Structure

```
openshift-mcp-server/
├── src/                            # MCP server source code
│   ├── index.js                    # Server entry point (hub/spoke/standalone modes)
│   ├── tools/                      # MCP tool implementations
│   │   ├── cluster.js              # Cluster info, events, resources
│   │   ├── nodes.js                # Node listing and details
│   │   ├── pods.js                 # Pod operations and logs
│   │   ├── namespaces.js           # Namespace management
│   │   ├── diagnostics.js          # Issue detection and health checks
│   │   ├── servicenow.js           # ITSM integration
│   │   ├── ansible.js              # Ansible Automation Platform
│   │   ├── emergency.js            # Emergency fix workflows
│   │   ├── acm.js                  # Advanced Cluster Management
│   │   ├── security.js             # Security scanning, SCC advisor
│   │   ├── network.js              # Network topology, policies
│   │   ├── workloads.js            # Workload management
│   │   ├── helm.js                 # Helm chart operations
│   │   ├── tekton.js               # Tekton CI/CD pipelines
│   │   ├── velero.js               # Backup and restore
│   │   └── ...                     # 40+ tool modules
│   ├── services/                   # Core services
│   │   ├── spoke-proxy.js          # Hub/spoke federation proxy
│   │   ├── agent-bridge.js         # Legacy agent bridge (fallback)
│   │   ├── chat-api.js             # AI chat interface
│   │   ├── nlu.js                  # Natural language understanding
│   │   ├── audit-log.js            # Action audit trail
│   │   ├── auth.js                 # Authentication
│   │   ├── llm.js                  # LLM provider abstraction
│   │   └── ...                     # 50+ service modules
│   ├── platform/                   # Platform abstraction (OpenShift/K8s)
│   ├── security/                   # Command validation, guardrails
│   ├── agents/                     # MCP router and agent registry
│   └── utils/                      # API clients (OpenShift, ServiceNow, Ansible)
├── console/                        # React dashboard (separate pod)
│   ├── Dockerfile                  # Nginx + React multi-stage build
│   ├── nginx.conf                  # Reverse proxy config → MCP server
│   ├── src/
│   │   ├── App.jsx                 # Main app (4-tab navigation)
│   │   ├── views/                  # Dashboard, Chat, Audit, AI Intelligence
│   │   ├── components/             # Reusable UI components
│   │   └── ...
│   ├── package.json
│   └── vite.config.js
├── deploy/                         # Deployment automation
│   ├── hub/
│   │   ├── deploy.sh               # Hub cluster deploy (MCP + Dashboard + DB)
│   │   └── manifests/              # K8s manifests (namespace, RBAC, postgres, redis, etc.)
│   └── spoke/
│       └── deploy.sh               # Spoke cluster deploy (MCP server only)
├── chart/                          # Helm chart
│   └── openshift-mcp/
│       ├── Chart.yaml
│       ├── values.yaml
│       └── templates/
├── adapters/                       # AI framework adapters
│   ├── anthropic-claude/           # Claude MCP client
│   ├── langchain/                  # LangChain adapter
│   ├── microsoft-agent-framework/  # Microsoft agent orchestrator
│   └── rest-api/                   # OpenAPI spec
├── docs/                           # Documentation
├── db/                             # Database schema (PostgreSQL)
├── tests/                          # Test suites
├── hack/                           # Build scripts and legacy tooling
├── backup/                         # Legacy agent and old dashboard
├── data/                           # Sample data (incident history)
├── examples/                       # Client configuration examples
├── Dockerfile                      # MCP server image (API-only)
├── package.json
├── .env.example
└── CLAUDE.md                       # Claude Code project instructions
```

---

## Container Images

### MCP Server (`Dockerfile`)

API-only Node.js server. No dashboard files.

```dockerfile
FROM node:20-alpine
# Runs as non-root (UID 1001)
# Exposes port 3000
# Entry: node src/index.js
```

Build:
```bash
podman build -t quay.io/your-org/openshift-mcp-server:latest .
```

### Dashboard (`console/Dockerfile`)

React SPA served by Nginx. Reverse proxies API calls to the MCP server.

```dockerfile
FROM node:20-alpine AS build  # Build React
FROM nginx:1.27-alpine        # Serve + proxy
# Runs as nginx user
# Exposes port 8080
# Proxies /api/* → mcp-server:3000
```

Build:
```bash
podman build -t quay.io/your-org/mcp-dashboard:latest ./console
```

---

## Security

- **Dedicated ServiceAccount** with least-privilege RBAC per cluster
- **Reader role** for information gathering (read-only operations)
- **Remediator role** for fix actions (pod delete, deployment patch, node cordon)
- Secrets stored in Kubernetes Secrets (consider External Secrets Operator for production)
- Container runs as **non-root** user (UID 1001 for MCP server, nginx user for dashboard)
- Spoke-to-hub communication over HTTPS (TLS terminated at OpenShift Route)
- ServiceNow credentials support Basic auth (OAuth extensible)
- Emergency webhook supports Slack, Teams, or any HTTP endpoint
- Command validation and guardrails prevent destructive operations without approval

---

## Example Conversations

**Cluster Overview:**
> "What's the current state of my OpenShift cluster?"

**Diagnose Issues:**
> "Are there any pods with issues in the production namespace?"

**Fix with Approval:**
> "The redis pod keeps getting OOMKilled. Can you increase its memory limit? Create a change request first."

**Emergency Fix:**
> "The API gateway is down in production! This is an emergency — restart the pod immediately."

**Multi-Cluster (via spoke):**
> "Show me the health status of the prod-east cluster."

**ACM:**
> "List all clusters managed by ACM and their compliance status."

**Ansible Remediation:**
> "Run the node-maintenance playbook on worker-2."

---

## License

MIT
