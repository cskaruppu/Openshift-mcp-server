# OpenShift MCP AI Assistant Server

A **Model Context Protocol (MCP)** server for **Red Hat OpenShift Container Platform** with integrations for **Advanced Cluster Management (ACM)**, **Ansible Automation Platform**, and **ServiceNow ITSM**.

This server enables AI assistants (Claude, ChatGPT, etc.) to interact with your OpenShift clusters — querying cluster state, diagnosing issues, raising ITSM tickets, and executing approved remediations.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    AI Assistant (Claude)                     │
│                 connected via MCP protocol                  │
└─────────────────┬───────────────────────────────────────────┘
                  │ stdio / SSE
┌─────────────────▼───────────────────────────────────────────┐
│              OpenShift MCP Server (Node.js)                 │
│                                                             │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────────┐  │
│  │ Cluster  │ │  Node    │ │   Pod     │ │  Namespace   │  │
│  │  Tools   │ │  Tools   │ │  Tools    │ │   Tools      │  │
│  └──────────┘ └──────────┘ └───────────┘ └──────────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────────┐  │
│  │Diagnostic│ │ServiceNow│ │  Ansible  │ │  Emergency   │  │
│  │  Tools   │ │  Tools   │ │  Tools    │ │   Tools      │  │
│  └──────────┘ └──────────┘ └───────────┘ └──────────────┘  │
│  ┌──────────┐ ┌──────────┐                                  │
│  │   ACM    │ │Dashboard │                                  │
│  │  Tools   │ │  Tools   │                                  │
│  └──────────┘ └──────────┘                                  │
└──────┬──────────────┬──────────────┬────────────────────────┘
       │              │              │
  ┌────▼────┐   ┌─────▼─────┐  ┌────▼─────┐
  │OpenShift│   │ServiceNow │  │ Ansible  │
  │  API    │   │   REST    │  │Controller│
  └─────────┘   └───────────┘  └──────────┘
```

---

## Features

### 1. Cluster Insights & Information Gathering
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

### 2. Diagnostics & Issue Detection
| Tool | Description |
|------|-------------|
| `diagnose_pod_issues` | Detects CrashLoopBackOff, ImagePullBackOff, OOMKilled, scheduling failures with fix suggestions |
| `diagnose_namespace_health` | Health check on all workloads — failing pods, unavailable deployments, quota pressure |
| `cluster_health_check` | Comprehensive cluster assessment — nodes, operators, critical components |

### 3. ServiceNow ITSM Integration
| Tool | Description |
|------|-------------|
| `create_servicenow_incident` | Create incident for detected issues |
| `create_change_request` | Create normal/standard/emergency change requests |
| `check_approval_status` | Check if a change request has been approved |
| `query_servicenow` | Query incidents, changes, problems |
| `update_servicenow_record` | Update records (close, add notes) |

### 4. Ansible Automation Platform
| Tool | Description |
|------|-------------|
| `list_ansible_job_templates` | List available remediation playbooks |
| `launch_ansible_job` | Run a playbook with extra variables |
| `check_ansible_job_status` | Monitor running job status |
| `list_ansible_inventories` | List inventories |
| `list_ansible_workflows` | List workflow templates |
| `launch_ansible_workflow` | Launch multi-step workflows |

### 5. Emergency Fixes
| Tool | Description |
|------|-------------|
| `emergency_fix` | Immediate fix with auto-created emergency change request and notification |
| `approved_fix` | Execute fix only after ITSM approval is confirmed |

Supported emergency actions: `restart_pod`, `scale_deployment`, `cordon_node`, `drain_node`, `rollback_deployment`, `delete_stuck_pod`

### 6. Multi-Cluster Management (ACM)
| Tool | Description |
|------|-------------|
| `list_managed_clusters` | All ACM managed clusters with health |
| `get_managed_cluster_details` | Detailed cluster info, claims, capacity |
| `list_acm_policies` | Governance policies and compliance |
| `search_across_clusters` | Search resources across all clusters |

### 7. Dashboard
| Tool | Description |
|------|-------------|
| `get_dashboard_summary` | Aggregated cluster data for the web dashboard |

---

## Prerequisites

- **OpenShift Container Platform** 4.12+ with cluster-admin or appropriate RBAC
- **Node.js** 20+ (for local development)
- **Red Hat ACM** (optional — for multi-cluster features)
- **Ansible Automation Platform** (optional — for playbook-based remediation)
- **ServiceNow** instance (optional — for ITSM integration)
- **Podman** or **Docker** (for container builds)

---

## Step-by-Step Setup Instructions

### Step 1: Clone the Repository

```bash
git clone https://github.com/cskaruppu/openshift-mcp-server.git
cd openshift-mcp-server
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your actual values:

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
```

### Step 4: Run Locally (Development)

```bash
# Test with stdio transport
node src/index.js

# Or with auto-reload
npm run dev
```

### Step 5: Connect to Claude Desktop

Add to your Claude Desktop `claude_desktop_config.json`:

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

Or connect to **Claude Code CLI**:

```bash
claude mcp add openshift-mcp -- node /path/to/openshift-mcp-server/src/index.js
```

### Step 6: Deploy to OpenShift

#### 6a. Build the Container Image

```bash
# Using Podman
podman build -t quay.io/your-org/openshift-mcp-server:latest .
podman push quay.io/your-org/openshift-mcp-server:latest

# Or using OpenShift BuildConfig
oc new-build --name=mcp-server --binary --strategy=docker -n openshift-mcp
oc start-build mcp-server --from-dir=. --follow -n openshift-mcp
```

#### 6b. Deploy the MCP Server

```bash
# Create namespace and RBAC
oc apply -f k8s/namespace.yaml
oc apply -f k8s/serviceaccount.yaml

# Configure secrets (EDIT FIRST!)
vi k8s/secret.yaml   # Replace placeholder values
oc apply -f k8s/secret.yaml
oc apply -f k8s/configmap.yaml

# Deploy the server
# Update the image in k8s/deployment.yaml first
oc apply -f k8s/deployment.yaml
```

#### 6c. Deploy the Dashboard

```bash
# Create ConfigMap from the dashboard HTML
oc create configmap mcp-dashboard \
  --from-file=index.html=dashboard/index.html \
  -n openshift-mcp \
  --dry-run=client -o yaml | oc apply -f -

# Deploy dashboard with nginx + Route
oc apply -f k8s/dashboard-deployment.yaml

# Get the dashboard URL
oc get route mcp-dashboard -n openshift-mcp -o jsonpath='{.spec.host}'
```

### Step 7: Verify the Deployment

```bash
# Check pods are running
oc get pods -n openshift-mcp

# Check MCP server logs
oc logs deployment/mcp-server -n openshift-mcp

# Access dashboard
open "https://$(oc get route mcp-dashboard -n openshift-mcp -o jsonpath='{.spec.host}')"
```

---

## ITSM Workflow

The server supports three remediation workflows:

### Normal Flow (with approval)
1. AI detects issue via diagnostic tools
2. Creates a **change request** in ServiceNow
3. Waits for manager approval
4. Once approved, executes fix via `approved_fix` tool
5. Updates ServiceNow ticket with resolution

### Emergency Flow
1. AI detects critical production issue
2. Calls `emergency_fix` tool
3. **Immediately** creates an emergency change request in ServiceNow
4. Executes the fix right away
5. Sends webhook notification to ops team
6. Post-approval and review follows

### Ansible-Driven Flow
1. AI detects issue
2. Creates ServiceNow ticket
3. After approval, launches Ansible playbook via `launch_ansible_job`
4. Monitors job via `check_ansible_job_status`
5. Updates ITSM ticket on completion

---

## Dashboard

The dashboard (`dashboard/index.html`) is a self-contained HTML file that provides:

- **Cluster health metrics** — nodes, operators, version
- **AI Chat interface** — simulated MCP tool interactions
- **Node overview table** — status, resources, pod counts
- **Active alerts** — critical, warning, info severity
- **ITSM workflow visualization** — 5-step remediation pipeline
- **Recent ITSM tickets** — incidents and change requests
- **Multi-cluster view** — ACM managed clusters with utilization
- **Emergency actions** — quick action buttons
- **Ansible integration** — available playbooks and launch controls

Open `dashboard/index.html` directly in a browser for a demo, or deploy via the K8s manifests for production.

---

## Project Structure

```
openshift-mcp-server/
├── src/
│   ├── index.js                  # MCP server entry point
│   ├── tools/
│   │   ├── cluster.js            # Cluster info, events, resources
│   │   ├── nodes.js              # Node listing and details
│   │   ├── pods.js               # Pod listing, details, logs, delete
│   │   ├── namespaces.js         # Namespace listing and details
│   │   ├── diagnostics.js        # Issue detection and health checks
│   │   ├── servicenow.js         # ITSM integration tools
│   │   ├── ansible.js            # Ansible Automation Platform tools
│   │   ├── emergency.js          # Emergency fix workflows
│   │   ├── acm.js                # Advanced Cluster Management tools
│   │   └── dashboard.js          # Dashboard summary data
│   └── utils/
│       ├── openshift-client.js   # OpenShift/K8s API client
│       ├── servicenow-client.js  # ServiceNow REST client
│       └── ansible-client.js     # Ansible Controller client
├── dashboard/
│   └── index.html                # MCP AI Assistant Dashboard (HTML)
├── k8s/
│   ├── namespace.yaml            # Namespace definition
│   ├── serviceaccount.yaml       # ServiceAccount + RBAC
│   ├── configmap.yaml            # Non-sensitive configuration
│   ├── secret.yaml               # Credentials (template)
│   ├── deployment.yaml           # MCP server deployment
│   └── dashboard-deployment.yaml # Dashboard nginx + Route
├── Dockerfile                    # Multi-stage container build
├── package.json
├── .env.example                  # Environment template
└── README.md
```

---

## Security Considerations

- The MCP server uses a **dedicated ServiceAccount** with least-privilege RBAC
- **Reader role** for information gathering (read-only)
- **Remediator role** for fix actions (pod delete, deployment patch, node cordon)
- Secrets are stored in Kubernetes Secrets (consider External Secrets Operator for production)
- Container runs as **non-root** with `readOnlyRootFilesystem`
- ServiceNow credentials support Basic auth (OAuth can be added)
- Emergency webhook supports Slack, Teams, or any HTTP endpoint

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

**Multi-Cluster:**
> "Show me all clusters managed by ACM and their health status."

**Ansible Remediation:**
> "Run the node-maintenance playbook on worker-2."

---

## License

MIT
