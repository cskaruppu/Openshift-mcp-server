# KubeNexus AI — Reference Architecture

> **KubeNexus AI** — Kubernetes Intelligence Platform powered by MCP (Model Context Protocol)
> for OpenShift Container Platform

---

## Two-Plane Multi-Cluster Architecture

KubeNexus AI separates the platform into two planes (the Red Hat ACM / Rancher pattern):

| Plane | Deployment | Components | State |
|:------|:-----------|:-----------|:------|
| **Management Plane** — *Management Bundle* | `./deploy/dashboard/deploy.sh` — deployed **once** | Dashboard (React + Nginx, 50Gi PVC) • Control Plane (`MCP_MODE=control`) • PostgreSQL (StatefulSet PVC) • Redis | **Stateful** — all settings, chats, audit, incidents, knowledge base in PostgreSQL |
| **Data Plane** — *MCP Server* | `./deploy/mcp/deploy.sh` — run on **every** cluster, **including the hub** | One stateless MCP server pod (`MCP_MODE=spoke`) with 40+ tools, executing live against its own cluster | **Stateless** — no DB, no PVC; kill/redeploy anytime |

```mermaid
flowchart TB
    subgraph MGMT["🏢 Management Cluster"]
        direction TB
        subgraph BUNDLE["Management Bundle — deployed once, persisted on PVCs"]
            DASHP["📊 Dashboard<br/><i>React + Nginx · 50Gi PVC</i>"]
            CTRL["⚙️ Control Plane<br/><i>MCP_MODE=control</i><br/><i>routing · auth · LLM config</i>"]
            PGB[("🐘 PostgreSQL<br/><i>PVC</i>")]
            RDB[("🔴 Redis")]
            DASHP --> CTRL
            CTRL --> PGB
            CTRL --> RDB
        end
        MCPH["🟣 MCP Server<br/><i>MCP_MODE=spoke</i><br/><i>registered as hub-cluster</i>"]
    end

    subgraph C1["🔵 Cluster prod-east"]
        MCP1["MCP Server<br/><i>MCP_MODE=spoke</i>"]
    end
    subgraph C2["🟢 Cluster staging-west"]
        MCP2["MCP Server<br/><i>MCP_MODE=spoke</i>"]
    end
    subgraph CN["🟠 Cluster N"]
        MCPN["MCP Server<br/><i>MCP_MODE=spoke</i>"]
    end

    CTRL -->|"live proxy<br/>(hub-cluster)"| MCPH
    CTRL -->|"live proxy"| MCP1
    CTRL -->|"live proxy"| MCP2
    CTRL -->|"live proxy"| MCPN
    MCPH -.->|"heartbeat 30s<br/>+ build version"| CTRL
    MCP1 -.->|"heartbeat 30s"| CTRL
    MCP2 -.->|"heartbeat 30s"| CTRL
    MCPN -.->|"heartbeat 30s"| CTRL

    style MGMT fill:#FFF3E0,stroke:#F57C00,stroke-width:3px,color:#E65100
    style BUNDLE fill:#F3E5F5,stroke:#7B1FA2,stroke-width:2px,color:#4A148C
    style C1 fill:#E8F4FD,stroke:#1976D2,stroke-width:2px,color:#0D47A1
    style C2 fill:#E8F5E9,stroke:#388E3C,stroke-width:2px,color:#1B5E20
    style CN fill:#FFF8E1,stroke:#F9A825,stroke-width:2px,color:#F57F17
```

**Design guarantees:**

1. **Identical answers fleet-wide** — every query (including the hub's own, via the `hub-cluster` pod) flows through the same spoke-proxy pipeline: same image, same code path, same formatting.
2. **The bundle is never touched by MCP refreshes** — MCP server pods use the `mcp-server` resource name family and carry no state; the bundle keeps its PVCs across any number of data-plane redeploys.
3. **Centralized LLM configuration** — credentials live only in the management plane and are injected per-request when chat is proxied to any cluster's pod.
4. **Self-healing registry** — heartbeats carry `spokeUrl` + build version; a control-plane restart re-registers every cluster within 30 seconds, and version drift surfaces as an "Update Available" badge with one-click ⋮ → Redeploy.

---

## Reference Architecture Diagram

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'fontSize': '14px', 'fontFamily': 'Red Hat Display, Segoe UI, Arial' }}}%%

flowchart TB

    subgraph USERS["&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;👤 USERS  &  CLIENTS&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"]
        direction LR
        U1("🌐 Web Browser<br/><b>Dashboard UI</b>")
        U2("🤖 Claude CLI<br/><b>claude.ai</b>")
        U3("💻 VS Code / JetBrains<br/><b>IDE Extensions</b>")
        U4("🔌 MCP Client<br/><b>SDK / stdio</b>")
    end

    subgraph NETWORK["&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;🌐 NETWORK  LAYER&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"]
        direction LR
        N1["🔒 TLS Termination<br/><i>HTTPS / WSS</i>"]
        N2["🛣️ OpenShift Route<br/><i>Edge TLS</i>"]
        N3["⚖️ HAProxy<br/><i>Load Balancer</i>"]
        N4["🔧 stdio<br/><i>Direct Transport</i>"]
    end

    subgraph OCP["&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;☸️ OPENSHIFT  CLUSTER  —  Namespace: openshift-mcp&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"]
        direction TB

        subgraph MCPSERVER["🚀 KubeNexus AI MCP Server &nbsp;•&nbsp; Node.js 20 &nbsp;•&nbsp; Port 3000"]
            direction LR

            subgraph CHATENG["💬 Chat Engine"]
                direction TB
                CE1["🧩 NLU Parser"]
                CE2["🧠 Context Memory"]
                CE3["📋 ITSM Handler"]
                CE4["✅ Action Workflow"]
                CE5["🔧 Fix Executor"]
            end

            subgraph TOOLENG["🛠️ MCP Tools<br/><i>33 Modules</i>"]
                direction TB
                TE1["☸️ Cluster Mgmt"]
                TE2["📊 Observability"]
                TE3["📦 App Lifecycle"]
                TE4["🔒 Security & Gov"]
                TE5["⚙️ Operations"]
            end

            subgraph DASHENG["🖥️ Dashboard"]
                direction TB
                DE1["📊 6 Views"]
                DE2["🏗️ Architecture"]
                DE3["🗺️ Heatmap"]
                DE4["🔮 AI Predictions"]
                DE5["⌨️ Command Bar"]
            end

            subgraph INTELENG["🧪 Intelligence"]
                direction TB
                IE1["👁️ Proactive Agent"]
                IE2["📚 Learning Engine"]
                IE3["🔍 Knowledge Base"]
                IE4["📈 Predictive Intel"]
            end
        end

        subgraph SECURITY["🛡️ Middleware"]
            direction LR
            S1["🔐 Auth<br/><i>Token / SA</i>"]
            S2["⏱️ Rate Limit<br/><i>Token Bucket</i>"]
            S3["🛑 Guardrails<br/><i>Safety Layer</i>"]
            S4["🙈 Redaction<br/><i>Secret Filter</i>"]
        end

        subgraph DATASTORE["💾 Data Services"]
            direction LR
            DB1[("🐘 PostgreSQL<br/><b>StatefulSet</b><br/><i>Port 5432</i>")]
            DB2[("🔴 Redis<br/><b>StatefulSet</b><br/><i>Port 6379</i>")]
        end
    end

    subgraph EXTERNAL["&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;🔗 EXTERNAL  SERVICES&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"]
        direction LR
        EX1["☸️ OpenShift API<br/><i>15+ Resource Types</i><br/><i>Nodes, Pods, Operators,</i><br/><i>Routes, Deployments</i>"]
        EX2["🤖 LLM Providers<br/><i>OpenAI</i><br/><i>Azure OpenAI</i><br/><i>Anthropic Claude</i><br/><i>Ollama (Local)</i>"]
        EX3["🎫 ServiceNow<br/><i>ITSM Platform</i><br/><i>Incidents</i><br/><i>Change Requests</i><br/><i>Approval Workflow</i>"]
        EX4["🅰️ Ansible Tower<br/><i>Automation Platform</i><br/><i>Job Templates</i><br/><i>Playbook Runs</i>"]
        EX5["📊 Prometheus<br/><i>Metrics & Alerts</i><br/><i>PromQL Queries</i><br/><i>AlertManager</i>"]
    end

    subgraph STORAGE["&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;💿 PERSISTENT  STORAGE  —  OpenShift PVCs&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"]
        direction LR
        PV1[("💿 dashboard-data<br/><b>50 Gi RWO</b><br/><i>Dashboard UI</i>")]
        PV2[("💿 postgres-data<br/><b>PVC RWO</b><br/><i>Settings, Chat History,</i><br/><i>Audit, Knowledge Base</i>")]
        PV3[("💿 redis-data<br/><b>RWO</b><br/><i>Cache, Sessions,</i><br/><i>Rate Limits</i>")]
    end

    U1 -->|"HTTPS"| N1
    U2 -->|"SSE / WS"| N1
    U3 -->|"MCP Protocol"| N2
    U4 -->|"stdio"| N4

    N1 --> N2
    N2 --> N3
    N3 -->|"Port 3000"| SECURITY
    N4 -->|"Direct"| SECURITY

    SECURITY --> MCPSERVER

    CHATENG -->|"K8s API"| EX1
    TOOLENG -->|"K8s API"| EX1
    CHATENG -->|"LLM Calls"| EX2
    CHATENG -->|"ITSM"| EX3
    TOOLENG -->|"Ansible"| EX4
    TOOLENG -->|"PromQL"| EX5

    MCPSERVER --> DATASTORE
    DB1 --> PV2
    DB2 --> PV3
    MCPSERVER -.-> PV1

    style USERS fill:#E8F4FD,stroke:#1976D2,stroke-width:3px,color:#0D47A1
    style NETWORK fill:#E0F2F1,stroke:#00897B,stroke-width:3px,color:#004D40
    style OCP fill:#FFF3E0,stroke:#F57C00,stroke-width:3px,color:#E65100
    style MCPSERVER fill:#F3E5F5,stroke:#7B1FA2,stroke-width:2px,color:#4A148C
    style CHATENG fill:#EDE7F6,stroke:#5E35B1,stroke-width:1px,color:#311B92
    style TOOLENG fill:#E8F5E9,stroke:#388E3C,stroke-width:1px,color:#1B5E20
    style DASHENG fill:#FCE4EC,stroke:#C2185B,stroke-width:1px,color:#880E4F
    style INTELENG fill:#E8EAF6,stroke:#3949AB,stroke-width:1px,color:#1A237E
    style SECURITY fill:#FFFDE7,stroke:#F9A825,stroke-width:2px,color:#F57F17
    style DATASTORE fill:#EFEBE9,stroke:#6D4C41,stroke-width:2px,color:#3E2723
    style EXTERNAL fill:#ECEFF1,stroke:#546E7A,stroke-width:3px,color:#263238
    style STORAGE fill:#F5F5F5,stroke:#757575,stroke-width:3px,color:#212121

    classDef userNode fill:#BBDEFB,stroke:#1565C0,stroke-width:2px,color:#0D47A1
    classDef netNode fill:#B2DFDB,stroke:#00796B,stroke-width:2px,color:#004D40
    classDef chatNode fill:#D1C4E9,stroke:#512DA8,stroke-width:1px,color:#311B92
    classDef toolNode fill:#C8E6C9,stroke:#2E7D32,stroke-width:1px,color:#1B5E20
    classDef dashNode fill:#F8BBD0,stroke:#AD1457,stroke-width:1px,color:#880E4F
    classDef intelNode fill:#C5CAE9,stroke:#283593,stroke-width:1px,color:#1A237E
    classDef secNode fill:#FFF9C4,stroke:#F9A825,stroke-width:1px,color:#F57F17
    classDef extNode fill:#CFD8DC,stroke:#455A64,stroke-width:2px,color:#263238
    classDef dbNode fill:#D7CCC8,stroke:#5D4037,stroke-width:2px,color:#3E2723
    classDef pvNode fill:#E0E0E0,stroke:#616161,stroke-width:2px,color:#212121

    class U1,U2,U3,U4 userNode
    class N1,N2,N3,N4 netNode
    class CE1,CE2,CE3,CE4,CE5 chatNode
    class TE1,TE2,TE3,TE4,TE5 toolNode
    class DE1,DE2,DE3,DE4,DE5 dashNode
    class IE1,IE2,IE3,IE4 intelNode
    class S1,S2,S3,S4 secNode
    class EX1,EX2,EX3,EX4,EX5 extNode
    class DB1,DB2 dbNode
    class PV1,PV2,PV3 pvNode
```

---

## Deployment Architecture

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'fontSize': '13px' }}}%%

flowchart TB
    subgraph OCPCLUSTER["☸️ OpenShift Cluster"]
        direction TB

        subgraph INGRESS["🌐 Ingress Layer"]
            direction LR
            DNS["📡 DNS<br/><i>*.apps.cluster</i>"]
            ROUTE["🛣️ Route<br/><i>agentic-ai-server</i><br/><i>TLS: edge</i>"]
            SVC["⚖️ Service<br/><i>ClusterIP:3000</i>"]
        end

        subgraph NAMESPACE["📁 Namespace: openshift-mcp"]
            direction TB

            subgraph COMPUTE["🚀 Compute"]
                direction LR
                DEP["📦 Deployment: agentic-ai-server<br/><b>Control Plane — MCP_MODE=control</b><br/><i>Image: quay.io/karuppucs/openshift-mcp-server:latest</i><br/><i>Replicas: 1 &nbsp;•&nbsp; Port: 3000 &nbsp;•&nbsp; stateless (state in PostgreSQL)</i><br/><i>Liveness: /healthz &nbsp;•&nbsp; Readiness: /readyz</i>"]
                MCPS["📦 Deployment: mcp-server<br/><b>Data Plane — MCP_MODE=spoke</b><br/><i>Same image &nbsp;•&nbsp; stateless, no PVC</i><br/><i>Registered as hub-cluster</i><br/><i>(also deployed on every other cluster)</i>"]
            end

            subgraph STATEFUL["🗄️ Stateful Services"]
                direction LR
                PG["🐘 StatefulSet<br/><b>PostgreSQL</b><br/><i>Port: 5432</i>"]
                REDIS["🔴 StatefulSet<br/><b>Redis</b><br/><i>Port: 6379</i>"]
            end

            subgraph CONFIG["⚙️ Configuration"]
                direction LR
                CM["📋 ConfigMap<br/><i>Environment vars</i>"]
                SEC["🔑 Secret<br/><i>API keys,</i><br/><i>DB credentials</i>"]
                SA["👤 ServiceAccount<br/><i>agentic-ai-server</i><br/><i>+ ClusterRoleBinding</i>"]
            end

            subgraph NETPOL["🔒 Network Security"]
                direction LR
                NP["🛡️ NetworkPolicy<br/><i>Allow from router</i><br/><i>Allow same namespace</i>"]
            end
        end

        subgraph VOLUMES["💿 Persistent Volumes — Management Bundle only"]
            direction LR
            V1[("💿 dashboard-data<br/><b>50Gi RWO</b>")]
            V2[("💿 pg-data<br/><b>PVC RWO</b>")]
            V3[("💿 redis-data<br/><b>RWO</b>")]
        end
    end

    DNS --> ROUTE --> SVC --> DEP
    DEP --> PG
    DEP --> REDIS
    DEP -->|"live proxy<br/>(spoke pipeline)"| MCPS
    DEP -.->|mount| CM
    DEP -.->|mount| SEC
    DEP -.->|bind| SA
    PG --> V2
    REDIS --> V3

    style OCPCLUSTER fill:#FFF3E0,stroke:#E65100,stroke-width:3px,color:#BF360C
    style INGRESS fill:#E0F2F1,stroke:#00897B,stroke-width:2px,color:#004D40
    style NAMESPACE fill:#E8F4FD,stroke:#1976D2,stroke-width:2px,color:#0D47A1
    style COMPUTE fill:#F3E5F5,stroke:#7B1FA2,stroke-width:1px,color:#4A148C
    style STATEFUL fill:#EFEBE9,stroke:#6D4C41,stroke-width:1px,color:#3E2723
    style CONFIG fill:#FFFDE7,stroke:#F9A825,stroke-width:1px,color:#F57F17
    style NETPOL fill:#FFEBEE,stroke:#C62828,stroke-width:1px,color:#B71C1C
    style VOLUMES fill:#F5F5F5,stroke:#757575,stroke-width:2px,color:#424242
```

---

## Data Flow: Chat Query Pipeline

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'fontSize': '13px' }}}%%

flowchart LR
    subgraph INPUT["📥 Input"]
        USER["👤 User"]
        BROWSER["🌐 Browser"]
    end

    subgraph PIPELINE["⚡ Processing"]
        NLU["🧩 NLU<br/><i>Intent + Entity</i>"]
        CACHE{{"🗄️ Cache<br/>Lookup"}}

        subgraph ROUTER["🔀 Intent Router"]
            direction TB
            RULE["📋 Rule-Based<br/><i>get, list, logs</i>"]
            ITSM["🎫 ITSM Form<br/><i>CR / Incident</i>"]
            LLM["🤖 LLM Agent<br/><i>Multi-turn +<br/>Tool Calls</i>"]
        end
    end

    subgraph BACKENDS["🔗 Backends"]
        K8S["☸️ K8s API"]
        LLMPROV["🤖 LLM Provider"]
        SNOW["🎫 ServiceNow"]
    end

    subgraph OUTPUT["📤 Output"]
        SSE["📡 SSE Stream"]
        STORE["💾 Redis Cache"]
    end

    USER -->|query| BROWSER
    BROWSER -->|POST /api/chat| NLU
    NLU --> CACHE
    CACHE -->|"✅ hit"| SSE
    CACHE -->|"❌ miss"| ROUTER
    RULE --> K8S --> SSE
    ITSM --> SNOW --> SSE
    LLM --> LLMPROV --> SSE
    SSE --> STORE

    style INPUT fill:#E8F4FD,stroke:#1976D2,stroke-width:2px,color:#0D47A1
    style PIPELINE fill:#F3E5F5,stroke:#7B1FA2,stroke-width:2px,color:#4A148C
    style ROUTER fill:#EDE7F6,stroke:#5E35B1,stroke-width:1px,color:#311B92
    style BACKENDS fill:#ECEFF1,stroke:#546E7A,stroke-width:2px,color:#263238
    style OUTPUT fill:#E8F5E9,stroke:#388E3C,stroke-width:2px,color:#1B5E20
```

---

## Component Summary

| Layer | Component | Count | Details |
|:------|:----------|:-----:|:--------|
| 🌐 **Network** | Protocols | 4 | HTTPS, SSE, stdio, WebSocket |
| 🛡️ **Security** | Middleware | 5 | Auth, Rate Limit, Guardrails, Redaction, CORS |
| 💬 **Chat** | NLU + Engines | 5 | Parser, Memory, ITSM, Workflow, Executor |
| 🛠️ **Tools** | MCP Modules | 33 | cluster, pods, security, helm, gitops, velero... |
| 🖥️ **Dashboard** | Views + Widgets | 6 + 15 | Dashboard, Chat, Audit, Hub, Intel, Settings |
| 🧪 **Intelligence** | AI Services | 8 | Proactive Agent, Learning, KB, Predictions... |
| 📡 **Endpoints** | HTTP APIs | 48+ | /api/chat, /api/actions, /api/intelligence/* |
| 🤖 **LLM** | Providers | 5 | OpenAI, Azure, Anthropic, Ollama, Built-in |
| 🔗 **External** | Integrations | 6 | OpenShift, LLMs, ServiceNow, Ansible, Prometheus, Redis |
| 💾 **Data** | Storage | 3 | PostgreSQL (8+ tables), Redis (cache), PVCs (management bundle only — MCP server pods are stateless) |

---

## Technology Stack

| Category | Technology |
|:---------|:-----------|
| **Runtime** | Node.js 20 on Alpine Linux |
| **Platform** | Red Hat OpenShift Container Platform 4.x |
| **Database** | PostgreSQL 15 (persistent) |
| **Cache** | Redis 7 (in-memory) |
| **AI/ML** | OpenAI GPT-4, Azure OpenAI, Anthropic Claude, Ollama |
| **Protocol** | MCP (Model Context Protocol), REST, SSE, WebSocket |
| **ITSM** | ServiceNow (Change Requests, Incidents) |
| **Automation** | Ansible Automation Platform |
| **Monitoring** | Prometheus, AlertManager |
| **Container** | quay.io/karuppucs/openshift-mcp-server |

---

*Reference Architecture for KubeNexus AI on Red Hat OpenShift Container Platform*
