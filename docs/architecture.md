# KubeNexus AI — System Architecture

## High-Level Architecture

```mermaid
graph TB
    subgraph CLIENTS["🖥️ USERS & CLIENTS"]
        direction LR
        C1["🌐 Web Browser<br/><i>Dashboard UI</i>"]
        C2["🔌 MCP Client<br/><i>SDK / stdio</i>"]
        C3["🤖 Claude CLI<br/><i>claude.ai</i>"]
        C4["💻 VS Code / JetBrains<br/><i>IDE Extensions</i>"]
    end

    subgraph SERVER["⚡ KubeNexus AI MCP Server &nbsp;(Node.js)"]
        direction TB

        subgraph TRANSPORT["🔀 Transport Layer"]
            direction LR
            T1["📡 HTTP/REST<br/><i>48+ API Endpoints</i>"]
            T2["📊 SSE Stream<br/><i>/sse</i>"]
            T3["🔧 stdio MCP<br/><i>Transport</i>"]
            T4["🔗 WebSocket<br/><i>/message</i>"]
        end

        subgraph MIDDLEWARE["🛡️ Middleware & Security"]
            direction LR
            M1["🔐 Auth<br/><i>Token / SA</i>"]
            M2["⏱️ Rate Limit<br/><i>Token Bucket</i>"]
            M3["🛑 Safety<br/><i>Guardrails</i>"]
            M4["🙈 Redaction<br/><i>Secrets Filter</i>"]
            M5["🌍 CORS<br/><i>Headers</i>"]
        end

        subgraph ENGINES["🧠 Core Engines"]
            direction LR

            subgraph CHAT["💬 Chat Engine"]
                direction TB
                CH1["🧩 NLU Parser<br/><i>Intent + Entity</i>"]
                CH2["🧠 Conversation Memory<br/><i>Context Tracking</i>"]
                CH3["📋 ITSM Handler<br/><i>CR / Incident Forms</i>"]
                CH4["✅ Action Workflow<br/><i>Approval Gate + SNOW</i>"]
                CH5["🔧 Fix Executor<br/><i>Dry Run + Execute</i>"]
                CH1 --> CH2 --> CH3 --> CH4 --> CH5
            end

            subgraph TOOLS["🛠️ MCP Tool Engine &nbsp;(33 Modules)"]
                direction TB
                TO1["☸️ Cluster Management<br/><i>cluster, acm, nodes,<br/>workloads, emergency</i>"]
                TO2["📊 Observability<br/><i>metrics, prometheus,<br/>diagnostics, timeline</i>"]
                TO3["📦 App Management<br/><i>helm, gitops, tekton,<br/>ansible, ossm, kubevirt</i>"]
                TO4["🔒 Security & Governance<br/><i>security, scc, policy-gen,<br/>compliance, drift</i>"]
                TO5["⚙️ Operations<br/><i>velero, generic, must-gather,<br/>impact, notifications</i>"]
                TO6["🔗 Integrations<br/><i>servicenow, ansible</i>"]
            end

            subgraph DASH["🖥️ Dashboard Engine"]
                direction TB
                D1["📄 Static Files<br/><i>gzip + cache headers</i>"]
                D2["📊 6 Views<br/><i>Dashboard, AI Chat,<br/>Audit, Hub, Intel, Settings</i>"]
                D3["✨ Unique Widgets<br/><i>Architecture, Timeline,<br/>Heatmap, Predictions, Cmd Bar</i>"]
            end
        end

        subgraph INTEL["🧪 Intelligence Layer"]
            direction LR
            I1["👁️ Proactive Agent<br/><i>Background Monitor</i>"]
            I2["📚 Learning Engine<br/><i>Pattern Learning</i>"]
            I3["🔍 Knowledge Base<br/><i>Vector Search</i>"]
            I4["📈 Predictive Intel<br/><i>Trend Analysis</i>"]
            I5["⚡ Automation Rules<br/><i>Event Triggers</i>"]
            I6["💰 Cost Advisor<br/><i>Resource Efficiency</i>"]
            I7["🔌 MCP Hub<br/><i>Multi-Server Orchestrate</i>"]
            I8["📝 Summarizer<br/><i>Context Compaction</i>"]
        end
    end

    subgraph EXTERNAL["🌐 External Integrations"]
        direction LR
        E1["☸️ OpenShift /<br/>Kubernetes API<br/><i>15+ Resource Types</i>"]
        E2["🤖 LLM Providers<br/><i>OpenAI, Azure, Anthropic,<br/>Ollama, Built-in</i>"]
        E3["🎫 ServiceNow<br/><i>ITSM: Incidents,<br/>Change Requests</i>"]
        E4["🅰️ Ansible<br/><i>Automation Platform:<br/>Job Templates</i>"]
        E5["📊 Prometheus /<br/>AlertManager<br/><i>Metrics & Alerts</i>"]
    end

    subgraph DATA["💾 Data Layer"]
        direction LR
        DB1["🐘 PostgreSQL<br/><i>chat_messages, conversations,<br/>pending_actions, query_log,<br/>knowledge_base, itsm_tickets</i>"]
        DB2["🔴 Redis<br/><i>Query cache, Rate limits,<br/>Session state, Health cache</i>"]
    end

    C1 -->|"HTTPS"| T1
    C2 -->|"stdio"| T3
    C3 -->|"SSE / WebSocket"| T2
    C4 -->|"MCP Protocol"| T4

    TRANSPORT --> MIDDLEWARE
    MIDDLEWARE --> ENGINES
    ENGINES --> INTEL

    CHAT -->|"K8s API"| E1
    TOOLS -->|"K8s API"| E1
    CHAT -->|"LLM Call"| E2
    CHAT -->|"ITSM"| E3
    TOOLS -->|"Ansible"| E4
    TOOLS -->|"PromQL"| E5

    INTEL -->|"Persist"| DB1
    INTEL -->|"Cache"| DB2
    CHAT -->|"Store"| DB1
    MIDDLEWARE -->|"Rate Limit"| DB2

    classDef clients fill:#DBEAFE,stroke:#2563EB,stroke-width:2px,color:#1E3A5F
    classDef transport fill:#CCFBF1,stroke:#0891B2,stroke-width:2px,color:#134E4A
    classDef middleware fill:#FEF3C7,stroke:#D97706,stroke-width:2px,color:#78350F
    classDef chat fill:#EDE9FE,stroke:#7C3AED,stroke-width:2px,color:#4C1D95
    classDef tools fill:#D1FAE5,stroke:#059669,stroke-width:2px,color:#064E3B
    classDef dashboard fill:#FCE7F3,stroke:#DB2777,stroke-width:2px,color:#831843
    classDef intel fill:#E0E7FF,stroke:#4F46E5,stroke-width:2px,color:#312E81
    classDef external fill:#FFEDD5,stroke:#EA580C,stroke-width:2px,color:#7C2D12
    classDef data fill:#F1F5F9,stroke:#475569,stroke-width:2px,color:#1E293B

    class C1,C2,C3,C4 clients
    class T1,T2,T3,T4 transport
    class M1,M2,M3,M4,M5 middleware
    class CH1,CH2,CH3,CH4,CH5 chat
    class TO1,TO2,TO3,TO4,TO5,TO6 tools
    class D1,D2,D3 dashboard
    class I1,I2,I3,I4,I5,I6,I7,I8 intel
    class E1,E2,E3,E4,E5 external
    class DB1,DB2 data
```

---

## Deployment Architecture (OpenShift)

```mermaid
graph TB
    subgraph CLUSTER["☸️ OpenShift Cluster"]
        direction TB

        subgraph NS["📁 Namespace: openshift-mcp"]
            direction TB

            subgraph DEP["🚀 Deployment: mcp-server"]
                POD["📦 Container: mcp-server<br/><i>Node.js 20 Alpine</i><br/><i>Port: 3000</i><br/><i>SA: mcp-server (cluster-admin RBAC)</i><br/><i>Health: /healthz, /readyz</i>"]
            end

            subgraph INFRA["🏗️ Infrastructure"]
                direction LR
                PG["🐘 StatefulSet: postgres<br/><i>Port: 5432 • PVC: 10Gi</i>"]
                RD["🔴 StatefulSet: redis<br/><i>Port: 6379 • PVC: 5Gi</i>"]
            end

            subgraph NET["🌐 Networking"]
                direction LR
                RT["🛣️ Route: mcp-server<br/><i>TLS: edge → Service:3000</i>"]
                NP["🔒 NetworkPolicy<br/><i>Allow ingress from<br/>router + same NS</i>"]
            end

            subgraph STORAGE["💾 Storage"]
                direction LR
                CM["📋 ConfigMap<br/><i>Environment Config</i>"]
                SEC["🔑 Secret<br/><i>Credentials</i>"]
                PVC["💿 PVC: mcp-data<br/><i>50Gi RWO</i>"]
            end
        end
    end

    RT -->|"HTTPS"| POD
    POD --> PG
    POD --> RD
    POD -.->|"Mount"| CM
    POD -.->|"Mount"| SEC
    PG -.->|"Store"| PVC

    classDef deployment fill:#DBEAFE,stroke:#2563EB,stroke-width:2px,color:#1E3A5F
    classDef infra fill:#FEF3C7,stroke:#D97706,stroke-width:2px,color:#78350F
    classDef network fill:#D1FAE5,stroke:#059669,stroke-width:2px,color:#064E3B
    classDef storage fill:#F1F5F9,stroke:#475569,stroke-width:2px,color:#1E293B

    class POD deployment
    class PG,RD infra
    class RT,NP network
    class CM,SEC,PVC storage
```

---

## Data Flow: User Chat Query

```mermaid
graph LR
    subgraph INPUT["📥 Input"]
        USER["👤 User"]
        BROWSER["🌐 Dashboard"]
    end

    subgraph PROCESS["⚡ Processing Pipeline"]
        NLU["🧩 NLU Parser<br/><i>Intent + Entity</i>"]
        CACHE["🗄️ Cache Lookup"]

        subgraph ROUTE["🔀 Intent Router"]
            direction TB
            RULE["📋 Rule-Based<br/><i>list, get, logs, top</i>"]
            ITSM["🎫 ITSM Form<br/><i>CR / Incident</i>"]
            LLM["🤖 LLM Agent<br/><i>Gather → Call LLM<br/>→ Tools → Stream</i>"]
        end
    end

    subgraph K8S["☸️ Cluster"]
        API["☸️ K8s API Call"]
        FMT["📝 Format as<br/>Markdown Tables"]
    end

    subgraph OUTPUT["📤 Output"]
        SSE["📡 SSE Stream<br/>to Browser"]
        STORE["💾 Cache Store<br/><i>Redis TTL</i>"]
    end

    USER -->|"Query"| BROWSER
    BROWSER -->|"POST /api/chat"| NLU
    NLU --> CACHE
    CACHE -->|"Hit"| SSE
    CACHE -->|"Miss"| ROUTE
    RULE --> API
    API --> FMT
    ITSM -->|"Return Form"| SSE
    LLM -->|"Stream"| SSE
    FMT --> SSE
    SSE --> STORE

    classDef input fill:#DBEAFE,stroke:#2563EB,stroke-width:2px,color:#1E3A5F
    classDef process fill:#EDE9FE,stroke:#7C3AED,stroke-width:2px,color:#4C1D95
    classDef k8s fill:#D1FAE5,stroke:#059669,stroke-width:2px,color:#064E3B
    classDef output fill:#FFEDD5,stroke:#EA580C,stroke-width:2px,color:#7C2D12
    classDef router fill:#FEF3C7,stroke:#D97706,stroke-width:2px,color:#78350F

    class USER,BROWSER input
    class NLU,CACHE process
    class RULE,ITSM,LLM router
    class API,FMT k8s
    class SSE,STORE output
```

---

## Component Statistics

| Category | Count | Details |
|:---------|:-----:|:--------|
| 📡 HTTP Endpoints | **48+** | `/api/chat`, `/api/actions`, `/api/intelligence/*`, `/api/cluster/*` |
| 🛠️ MCP Tool Modules | **33** | cluster, pods, security, gitops, velero, helm, ansible... |
| ⚙️ Service Modules | **33** | llm, nlu, chat-api, action-workflow, fix-executor... |
| 🔧 Utility Modules | **6** | openshift-client, db, cache, config, rate-limit, redact |
| 🤖 LLM Providers | **5** | OpenAI, Azure OpenAI, Anthropic (Claude), Ollama, Built-in |
| 🖥️ Dashboard Views | **6** | Dashboard, AI Chat, Audit Log, AI Hub, Intelligence, Settings |
| ✨ Dashboard Widgets | **15+** | Architecture, Timeline, Heatmap, Predictions, Cmd Bar, Security... |
| ☸️ K8s Manifests | **10** | namespace, deployment, service, route, PVC, configmap, secret... |
| 🌐 External Systems | **6** | OpenShift, LLMs, ServiceNow, Ansible, Prometheus, Redis |
| 💾 Database Tables | **8+** | conversations, messages, actions, audit, knowledge_base... |

---

## Technology Stack

```mermaid
graph LR
    subgraph RUNTIME["Runtime"]
        NODE["Node.js 20"]
        ALPINE["Alpine Linux"]
    end

    subgraph PROTOCOLS["Protocols"]
        HTTP["HTTP/REST"]
        SSE["SSE"]
        STDIO["stdio"]
        WS["WebSocket"]
        MCP["MCP"]
    end

    subgraph STORAGE["Storage"]
        PG["PostgreSQL"]
        REDIS["Redis"]
    end

    subgraph PLATFORM["Platform"]
        OCP["OpenShift 4.x"]
        K8S["Kubernetes"]
        OLM["OLM"]
    end

    subgraph AI["AI / ML"]
        OPENAI["OpenAI"]
        AZURE["Azure OpenAI"]
        CLAUDE["Anthropic Claude"]
        OLLAMA["Ollama"]
    end

    classDef runtime fill:#DBEAFE,stroke:#2563EB,stroke-width:2px,color:#1E3A5F
    classDef protocol fill:#CCFBF1,stroke:#0891B2,stroke-width:2px,color:#134E4A
    classDef store fill:#FEF3C7,stroke:#D97706,stroke-width:2px,color:#78350F
    classDef platform fill:#D1FAE5,stroke:#059669,stroke-width:2px,color:#064E3B
    classDef ai fill:#EDE9FE,stroke:#7C3AED,stroke-width:2px,color:#4C1D95

    class NODE,ALPINE runtime
    class HTTP,SSE,STDIO,WS,MCP protocol
    class PG,REDIS store
    class OCP,K8S,OLM platform
    class OPENAI,AZURE,CLAUDE,OLLAMA ai
```
