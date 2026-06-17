# TCS Agentic AI — Product Overview

## OpenShift Intelligence Platform with AI-Powered Cluster Operations

---

### What is TCS Agentic AI?

TCS Agentic AI is an enterprise-grade AI-powered operations platform for Red Hat OpenShift and Kubernetes clusters. It transforms cluster management from a manual, command-line-driven process into an intelligent, conversational, and automated experience.

Built on the Model Context Protocol (MCP), Agentic AI connects directly to cluster APIs and combines real-time observability with AI-powered diagnosis, remediation, and predictive intelligence — all through a unified web dashboard.

---

### The Problem We Solve

| Challenge | Impact |
|-----------|--------|
| Engineers spend 30-60 minutes diagnosing each incident | High MTTR, prolonged outages |
| kubectl/oc CLI requires deep expertise | Steep learning curve, slow onboarding |
| Monitoring tools show symptoms, not root causes | Engineers investigate manually |
| Knowledge lives in people's heads | Lost when engineers leave the team |
| L1/L2 support lacks cluster expertise | Escalations slow resolution |
| Multiple tools for different tasks | Context switching, fragmented workflow |
| Compliance audits require manual evidence gathering | Time-consuming, error-prone |

### How TCS Agentic AI Solves It

| Solution | How |
|----------|-----|
| **AI Diagnosis** | Pod Doctor auto-diagnoses issues in seconds, not minutes |
| **Natural Language** | Ask "why is my pod crashing?" instead of memorizing oc commands |
| **Root Cause Analysis** | AI correlates logs, events, metrics, and node conditions automatically |
| **Knowledge Base** | Resolutions captured and reused — knowledge stays with the org |
| **One-Click Remediation** | AI suggests fixes, Dry Run validates, Apply executes — with guardrails |
| **Single Pane of Glass** | Dashboard + Chat + Alerts + Metrics in one interface |
| **Continuous Compliance** | Automated security scanning with CIS benchmarks |

---

### Platform Components

#### 1. AI-Powered Web Dashboard
The command center for cluster operations. Real-time visibility across pods, nodes, operators, and namespaces — with AI risk predictions updated every 15 seconds via Server-Sent Events.

**Key Widgets:**
- Cluster health overview with version, node count, and operator status
- Namespace heatmap showing issue distribution
- AI Risk Predictions with 100% evidence-based accuracy
- Security posture score with findings
- GitOps sync status (ArgoCD integration)
- DR readiness score (Velero backup analysis)
- Resource optimization with waste detection
- Active alerts from Alertmanager
- Multi-cluster management (ACM)

#### 2. AI Chat Interface
Natural language cluster management. Engineers describe what they need in plain English, and Agentic AI translates it into cluster operations.

**Capabilities:**
- "Troubleshoot pod mlflow-server in namespace mlflow"
- "Why is my deployment crashing?"
- "Scale nginx to 3 replicas in production"
- "Show me all OOMKilled pods"
- "Raise a change request for memory increase"
- Multi-turn conversations with context memory
- AI confidence scoring on every response
- Follow-up suggestions after each answer

#### 3. AI Intelligence Command Center
Unified observability hub with real-time streaming, replacing fragmented monitoring tools.

**Sections:**
- **Live Alert Feed** — AI-investigated alerts with severity filtering, namespace grouping, and one-click remediation
- **Risk Predictions** — Evidence-based (100%) + LLM deep analysis (70-99%) findings
- **Live Cluster Status** — SSE-powered real-time counters for pods, nodes, operators, events
- **Root Cause Analysis** — AI-powered causal chain investigation on any finding
- **Predictive Intelligence** — Trend-based forecasting of future issues
- **Automation Rules** — "When X happens, do Y" natural language triggers
- **Knowledge Base** — Learned resolutions from past incidents

#### 4. MCP Server & Agent Architecture
12 specialized AI agents for domain-specific cluster operations, orchestrated by an MCP Hub that can connect to multiple MCP servers.

**Agents:**
| Agent | Domain |
|-------|--------|
| Diagnostics & Healing | Pod/deployment troubleshooting, auto-remediation |
| Security & Compliance | SCC analysis, RBAC audit, CIS benchmarks |
| Cluster Operations | Node management, resource allocation |
| Upgrade Lifecycle | Version advisor, preflight checks, upgrade execution |
| Observability | Prometheus queries, alerting, metrics analysis |
| CI/CD & GitOps | ArgoCD sync, Tekton pipelines |
| Networking & Mesh | Service mesh, network policies, connectivity |
| ITSM & Change Management | ServiceNow integration, change requests |
| Multi-Cluster (ACM) | Federated cluster management |
| Infrastructure & Virtualization | KubeVirt VMs, infrastructure operations |
| Workload Management | Deployment scaling, resource optimization |
| Proactive Intelligence | Continuous scanning, pattern detection |

#### 5. Fix Execution Engine
Safe, controlled cluster modifications with multiple layers of protection.

**Safety Layers:**
1. **AI Proposal** — AI suggests the fix with risk assessment
2. **Dry Run** — Server-side simulation before actual execution
3. **Approval Chains** — Multi-level approval for production changes
4. **Guardrails** — Blocks destructive operations (delete namespace, delete CRDs, etc.)
5. **Audit Trail** — Every action logged with who, what, when
6. **Before/After Comparison** — Shows resource limits before and after changes
7. **Post-Fix Monitoring** — Auto-polls pod status until Running

---

### Supported LLM Providers

Agentic AI is vendor-neutral — choose the AI provider that fits your organization:

| Provider | Deployment | Best For |
|----------|-----------|----------|
| **Anthropic Claude** (Opus/Sonnet/Haiku) | Cloud | Highest accuracy, complex analysis |
| **IBM Watsonx** | Cloud / On-prem | Enterprise AI with IBM support |
| **Ollama** | On-premises | Air-gapped environments, data sovereignty |
| **Azure OpenAI** | Cloud | Microsoft enterprise ecosystem |
| **OpenAI** (GPT-4) | Cloud | General purpose |
| **Groq** | Cloud | Ultra-fast inference |

---

### Enterprise Integrations

| Integration | Purpose |
|-------------|---------|
| **Red Hat OpenShift** | Native OCP integration via service account |
| **Prometheus** | PromQL queries, metric analysis |
| **Alertmanager** | Alert ingestion, triage, and remediation |
| **ServiceNow** | Incident creation, change requests, approval workflows |
| **Ansible Automation Platform** | Playbook execution for complex remediation |
| **ArgoCD** | GitOps sync status, drift detection |
| **Velero** | Backup status, DR readiness analysis |
| **PostgreSQL** | Persistent chat history, knowledge base, audit logs |
| **OpenTelemetry** | Distributed tracing, metrics export |
| **ACM (Advanced Cluster Management)** | Multi-cluster federation |

---

### Technical Specifications

| Specification | Detail |
|--------------|--------|
| **Runtime** | Node.js 18+ |
| **Transport** | HTTP/SSE (dashboard), stdio (MCP clients) |
| **Database** | PostgreSQL (optional — falls back to in-memory) |
| **Authentication** | OpenShift service account / OPENSHIFT_TOKEN |
| **Deployment** | OpenShift pod, Docker container, or standalone |
| **Dashboard** | Single-page application (no framework dependencies) |
| **MCP Protocol** | Full MCP 1.0 support with tools, resources, prompts |
| **API** | RESTful + Server-Sent Events (SSE) |

---

### Deployment Options

| Option | Description |
|--------|------------|
| **OpenShift Pod** | Deploy as a pod with service account — recommended |
| **Docker/Podman** | Container image with cluster credentials mounted |
| **Standalone** | Run directly with OPENSHIFT_TOKEN environment variable |
| **Helm Chart** | Production deployment with configurable values |

---

*TCS Agentic AI v1.0.0 | May 2026*
