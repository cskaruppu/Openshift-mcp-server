# KubeNexus AI — Architecture Diagram

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                    USERS / CLIENTS                                      │
│                                                                                         │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐   │
│   │  Web Browser  │   │  MCP Client  │   │  Claude CLI  │   │  VS Code / JetBrains │   │
│   │  (Dashboard)  │   │  (SDK/stdio) │   │  (claude.ai) │   │   (IDE Extensions)   │   │
│   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘   └──────────┬───────────┘   │
│          │                  │                   │                      │                 │
│          │ HTTPS            │ stdio             │ SSE/WebSocket        │ MCP Protocol    │
└──────────┼──────────────────┼───────────────────┼──────────────────────┼─────────────────┘
           │                  │                   │                      │
           ▼                  ▼                   ▼                      ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              KubeNexus AI MCP Server                                    │
│                              (Node.js — src/index.js)                                   │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │                           TRANSPORT LAYER                                       │    │
│  │                                                                                 │    │
│  │   ┌─────────────┐    ┌──────────────┐    ┌─────────────┐    ┌──────────────┐   │    │
│  │   │  HTTP/REST   │    │  SSE Stream  │    │  stdio MCP  │    │  WebSocket   │   │    │
│  │   │  (48+ APIs)  │    │  (/sse)      │    │  Transport  │    │  (/message)  │   │    │
│  │   └──────┬───────┘    └──────┬───────┘    └──────┬──────┘    └──────┬───────┘   │    │
│  └──────────┼───────────────────┼───────────────────┼──────────────────┼────────────┘    │
│             │                   │                   │                  │                  │
│             ▼                   ▼                   ▼                  ▼                  │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │                        MIDDLEWARE & SECURITY                                     │    │
│  │                                                                                 │    │
│  │   ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌─────────┐ │    │
│  │   │    Auth     │  │ Rate Limit │  │  Safety    │  │ Redaction  │  │  CORS   │ │    │
│  │   │ (Token/SA)  │  │(Token Bucket│  │(Guardrails)│  │ (Secrets)  │  │ Headers │ │    │
│  │   └────────────┘  └────────────┘  └────────────┘  └────────────┘  └─────────┘ │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                         │                                                │
│             ┌───────────────────────────┼───────────────────────────┐                    │
│             ▼                           ▼                           ▼                    │
│  ┌───────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐          │
│  │   CHAT ENGINE     │    │    MCP TOOL ENGINE    │    │  DASHBOARD ENGINE    │          │
│  │                   │    │                       │    │                      │          │
│  │ ┌───────────────┐ │    │  33 Tool Modules:     │    │ ┌──────────────┐    │          │
│  │ │  NLU Parser   │ │    │                       │    │ │ Static Files │    │          │
│  │ │ (Intent +     │ │    │  ┌─────────────────┐  │    │ │ (gzip + cache│    │          │
│  │ │  Entity       │ │    │  │ Cluster Mgmt    │  │    │ │  headers)    │    │          │
│  │ │  Extraction)  │ │    │  │ cluster, acm,   │  │    │ └──────────────┘    │          │
│  │ └───────┬───────┘ │    │  │ nodes, workloads│  │    │ ┌──────────────┐    │          │
│  │         │         │    │  │ emergency       │  │    │ │ 6 Views:     │    │          │
│  │ ┌───────▼───────┐ │    │  └─────────────────┘  │    │ │ • Dashboard  │    │          │
│  │ │ Conversation  │ │    │  ┌─────────────────┐  │    │ │ • AI Chat    │    │          │
│  │ │ Memory        │ │    │  │ Observability   │  │    │ │ • Audit      │    │          │
│  │ │ (Context      │ │    │  │ metrics, prom,  │  │    │ │ • AI Hub     │    │          │
│  │ │  tracking)    │ │    │  │ diagnostics,    │  │    │ │ • AI Intel   │    │          │
│  │ └───────┬───────┘ │    │  │ timeline        │  │    │ │ • Settings   │    │          │
│  │         │         │    │  └─────────────────┘  │    │ └──────────────┘    │          │
│  │ ┌───────▼───────┐ │    │  ┌─────────────────┐  │    │ ┌──────────────┐    │          │
│  │ │ ITSM Handler  │ │    │  │ App Management  │  │    │ │ Unique:      │    │          │
│  │ │ (CR/Incident  │ │    │  │ helm, gitops,   │  │    │ │ • Topology   │    │          │
│  │ │  auto-forms)  │ │    │  │ tekton, ansible, │  │    │ │ • Timeline   │    │          │
│  │ └───────┬───────┘ │    │  │ ossm, kubevirt  │  │    │ │ • Heatmap    │    │          │
│  │         │         │    │  └─────────────────┘  │    │ │ • Predictions│    │          │
│  │ ┌───────▼───────┐ │    │  ┌─────────────────┐  │    │ │ • Cmd Bar    │    │          │
│  │ │ Action        │ │    │  │ Security & Gov   │  │    │ └──────────────┘    │          │
│  │ │ Workflow      │ │    │  │ security, scc,   │  │    └──────────────────────┘          │
│  │ │ (Approval     │ │    │  │ policy-gen,      │  │                                     │
│  │ │  Gate + SNOW) │ │    │  │ compliance, drift│  │                                     │
│  │ └───────┬───────┘ │    │  └─────────────────┘  │                                     │
│  │         │         │    │  ┌─────────────────┐  │                                     │
│  │ ┌───────▼───────┐ │    │  │ Operations      │  │                                     │
│  │ │ Fix Executor  │ │    │  │ velero, generic, │  │                                     │
│  │ │ (Dry Run +    │ │    │  │ mustgather,     │  │                                     │
│  │ │  Execute)     │ │    │  │ impact, notif   │  │                                     │
│  │ └───────────────┘ │    │  └─────────────────┘  │                                     │
│  └───────────────────┘    │  ┌─────────────────┐  │                                     │
│                           │  │ Integrations    │  │                                     │
│                           │  │ servicenow,     │  │                                     │
│                           │  │ ansible         │  │                                     │
│                           │  └─────────────────┘  │                                     │
│                           └──────────────────────┘                                      │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │                        INTELLIGENCE LAYER                                       │    │
│  │                                                                                 │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐   │    │
│  │  │  Proactive   │  │  Learning    │  │  Knowledge   │  │  Predictive       │   │    │
│  │  │  Agent       │  │  Engine      │  │  Base        │  │  Intel            │   │    │
│  │  │ (Background  │  │ (Pattern     │  │ (Vector      │  │ (Trend Analysis   │   │    │
│  │  │  monitoring) │  │  learning)   │  │  search)     │  │  + Forecasting)   │   │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  └───────────────────┘   │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐   │    │
│  │  │  Automation  │  │  Cost        │  │  MCP Hub     │  │  Summarizer       │   │    │
│  │  │  Rules       │  │  Advisor     │  │ (Multi-server│  │ (Context          │   │    │
│  │  │ (Event       │  │ (Resource    │  │  orchestrate)│  │  compaction)      │   │    │
│  │  │  triggers)   │  │  efficiency) │  │              │  │                   │   │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  └───────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────────────┘
           │                    │                    │                    │
           ▼                    ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           EXTERNAL INTEGRATIONS                                         │
│                                                                                         │
│  ┌─────────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐    │
│  │ OpenShift /     │  │  LLM         │  │  ServiceNow  │  │  Ansible             │    │
│  │ Kubernetes API  │  │  Providers   │  │  (ITSM)      │  │  Automation          │    │
│  │                 │  │              │  │              │  │  Platform             │    │
│  │ • Cluster API   │  │ • OpenAI     │  │ • Incidents  │  │                      │    │
│  │ • Nodes API     │  │ • Azure      │  │ • Change     │  │ • Job Templates      │    │
│  │ • Pods API      │  │   OpenAI     │  │   Requests   │  │ • Playbook Run       │    │
│  │ • Events API    │  │ • Anthropic  │  │ • Approval   │  │ • Status Poll        │    │
│  │ • Operators     │  │   (Claude)   │  │   Workflow   │  │                      │    │
│  │ • Routes        │  │ • Ollama     │  │ • Query      │  └──────────────────────┘    │
│  │ • Deployments   │  │   (Local)    │  │   Records    │                               │
│  │ • Services      │  │ • Built-in   │  └──────────────┘  ┌──────────────────────┐    │
│  │ • ConfigMaps    │  │   (Rule-     │                    │  Prometheus /         │    │
│  │ • Secrets       │  │    based)    │                    │  AlertManager         │    │
│  │ • PVCs          │  └──────────────┘                    │                      │    │
│  │ • Metrics API   │                                      │ • Metric Queries     │    │
│  │ • ACM           │                                      │ • Alert Retrieval    │    │
│  │ • ArgoCD        │                                      │ • Silence Mgmt       │    │
│  │ • Tekton        │                                      │ • Range Queries      │    │
│  │ • KubeVirt      │                                      └──────────────────────┘    │
│  │ • Velero        │                                                                   │
│  │ • Service Mesh  │                                                                   │
│  └─────────────────┘                                                                   │
└─────────────────────────────────────────────────────────────────────────────────────────┘
           │                                         │
           ▼                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              DATA LAYER                                                 │
│                                                                                         │
│  ┌───────────────────────────────┐    ┌───────────────────────────────┐                 │
│  │  PostgreSQL                   │    │  Redis                        │                 │
│  │                               │    │                               │                 │
│  │  • chat_messages              │    │  • Query result cache         │                 │
│  │  • conversations              │    │  • Rate limit counters        │                 │
│  │  • pending_actions            │    │  • Session state              │                 │
│  │  • query_log (audit)          │    │  • Health check cache         │                 │
│  │  • executed_actions           │    │                               │                 │
│  │  • itsm_tickets               │    │                               │                 │
│  │  • knowledge_base             │    │                               │                 │
│  │  • silenced_alerts            │    │                               │                 │
│  └───────────────────────────────┘    └───────────────────────────────┘                 │
└─────────────────────────────────────────────────────────────────────────────────────────┘


## Deployment Architecture (OpenShift)

┌─────────────────────────────────────────────────────────────────────┐
│                    OpenShift Cluster                                 │
│                    Namespace: openshift-mcp                         │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Deployment: mcp-server                                     │   │
│  │  Image: quay.io/karuppucs/openshift-mcp-server:latest      │   │
│  │  Port: 3000                                                 │   │
│  │  ┌─────────────────────────────────────────────────────┐   │   │
│  │  │  Container: mcp-server (Node.js 20 Alpine)          │   │   │
│  │  │  • Mounts: ConfigMap (env), Secret (credentials)    │   │   │
│  │  │  • SA: mcp-server (cluster-admin RBAC)              │   │   │
│  │  │  • Health: /healthz, /readyz                        │   │   │
│  │  └─────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐  │
│  │  StatefulSet:   │   │  StatefulSet:   │   │  Route:          │  │
│  │  postgres       │   │  redis          │   │  mcp-server      │  │
│  │  Port: 5432     │   │  Port: 6379     │   │  TLS: edge       │  │
│  │  PVC: 10Gi      │   │  PVC: 5Gi       │   │  → Service:3000  │  │
│  └─────────────────┘   └─────────────────┘   └─────────────────┘  │
│                                                                     │
│  ┌──────────────────────┐   ┌──────────────────────┐              │
│  │  NetworkPolicy:      │   │  PVC: mcp-data       │              │
│  │  Allow ingress from  │   │  50Gi RWO            │              │
│  │  router + same NS    │   │  Server state        │              │
│  └──────────────────────┘   └──────────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘


## Data Flow: User Chat Query

┌──────┐    ┌───────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ User │───▶│ Dashboard │───▶│ NLU      │───▶│ Cache    │───▶│ Return   │
│      │    │ (Browser) │    │ Parser   │    │ Lookup   │    │ Cached   │
└──────┘    └───────────┘    └──────────┘    └──────┬───┘    └──────────┘
                                                    │ miss
                                                    ▼
                                            ┌──────────────┐
                                            │ Intent Route │
                                            └──────┬───────┘
                           ┌───────────────────────┼───────────────────────┐
                           ▼                       ▼                       ▼
                   ┌──────────────┐       ┌──────────────┐       ┌──────────────┐
                   │  Rule-Based  │       │  ITSM Form   │       │  LLM Agent   │
                   │  Handler     │       │  Builder     │       │  Loop        │
                   │ (list, get,  │       │ (CR/Incident │       │              │
                   │  logs, top)  │       │  auto-fill)  │       │  ┌────────┐  │
                   └──────┬───────┘       └──────┬───────┘       │  │ Gather │  │
                          │                      │               │  │Context │  │
                          ▼                      ▼               │  └───┬────┘  │
                   ┌──────────────┐       ┌──────────────┐       │      │       │
                   │ K8s API Call │       │ Return Form  │       │  ┌───▼────┐  │
                   │ (OpenShift   │       │ (Interactive │       │  │Call LLM│  │
                   │  Client)     │       │  in chat)    │       │  │+ Tools │  │
                   └──────┬───────┘       └──────────────┘       │  └───┬────┘  │
                          │                                      │      │       │
                          ▼                                      │  ┌───▼────┐  │
                   ┌──────────────┐                              │  │Stream  │  │
                   │ Format as    │                              │  │Response│  │
                   │ Markdown     │                              │  └────────┘  │
                   │ Tables       │                              └──────────────┘
                   └──────┬───────┘
                          │
                          ▼
                   ┌──────────────┐    ┌──────────────┐
                   │ SSE Stream   │───▶│ Cache Store  │
                   │ to Browser   │    │ (Redis TTL)  │
                   └──────────────┘    └──────────────┘


## Component Statistics

| Category            | Count | Examples                                         |
|---------------------|-------|--------------------------------------------------|
| HTTP Endpoints      | 48+   | /api/chat, /api/actions, /api/intelligence/*     |
| MCP Tool Modules    | 33    | cluster, pods, security, gitops, velero...       |
| Service Modules     | 33    | llm, nlu, chat-api, action-workflow...           |
| Utility Modules     | 6     | openshift-client, db, cache, config...           |
| LLM Providers       | 5     | OpenAI, Azure, Anthropic, Ollama, Built-in       |
| Dashboard Views     | 6     | Dashboard, Chat, Audit, Hub, Intelligence, Settings |
| Dashboard Widgets   | 15+   | Topology, Timeline, Heatmap, Predictions, CmdBar |
| K8s Manifests       | 10    | namespace, deployment, service, route, PVC...    |
| External Systems    | 6     | OpenShift, LLMs, ServiceNow, Ansible, Prometheus, Redis |
| Database Tables     | 8+    | conversations, messages, actions, audit, KB...   |
```
