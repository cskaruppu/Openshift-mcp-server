# Microsoft Agent Framework Adapter — TCS Agentic AI

Connect any Microsoft Agent Framework agent (.NET or Python) to TCS Agentic
AI. The platform exposes 12 specialist agents and 162+ tools through standard
MCP (Model Context Protocol) — Microsoft Agent Framework consumes these
natively as **Local MCP Tools**.

> No changes to the TCS Agentic AI server are required. These adapters
> only run on the customer's side.

---

## Why Microsoft Agent Framework + TCS Agentic AI?

| | TCS Agentic AI | MS Agent Framework |
|---|---|---|
| Provides | OpenShift cluster tools, ITSM, ServiceNow, RBAC, audit | Agent runtime, LLM orchestration, multi-agent workflows |
| Standard | MCP server | Agent framework |
| Together | Cluster expertise + framework choice + Azure integration | |

You get the best of both: enterprise OpenShift tooling from TCS, plus
Microsoft's framework patterns (typed workflows, checkpointing, telemetry).

---

## Two Integration Patterns

### Pattern A — Single agent, full tool surface

One MS Agent Framework agent connects to the full MCP server (162 tools).
Best when you want the simplest setup or when the LLM should choose freely
across all tool categories.

See [`single-agent.py`](single-agent.py).

### Pattern B — Multi-agent orchestrator (Recommended)

One MS Agent Framework agent per TCS specialist. Each MS agent connects
only to its corresponding per-agent MCP endpoint. An orchestrator agent
routes intent across them. Best for production, audit, and explainability.

See [`multi-agent-orchestrator.py`](multi-agent-orchestrator.py).

---

## Setup

```bash
pip install -r requirements.txt

# Authenticate to Azure (one-time)
az login

# Set environment
export FOUNDRY_PROJECT_ENDPOINT="https://your-project.services.ai.azure.com/api/projects/your-project"
export FOUNDRY_MODEL="gpt-4o-mini"
export TCS_AGENTIC_URL="https://mcp-server-openshift-mcp.apps.openshift.caaslab.local"
export TCS_AGENTIC_BEARER="<your-token>"   # if auth is enabled

# Run
python single-agent.py
python multi-agent-orchestrator.py
```

---

## Agent ↔ MCP Endpoint Mapping

| TCS Agent ID | MS Agent Role | MCP URL |
|---|---|---|
| `cluster-operations` | Cluster Ops | `${TCS_AGENTIC_URL}/mcp/cluster-operations/sse` |
| `workload-management` | Workload | `${TCS_AGENTIC_URL}/mcp/workload-management/sse` |
| `diagnostics-healing` | Diagnostics | `${TCS_AGENTIC_URL}/mcp/diagnostics-healing/sse` |
| `upgrade-lifecycle` | Upgrade | `${TCS_AGENTIC_URL}/mcp/upgrade-lifecycle/sse` |
| `itsm-change-management` | ITSM | `${TCS_AGENTIC_URL}/mcp/itsm-change-management/sse` |
| `security-compliance` | Security | `${TCS_AGENTIC_URL}/mcp/security-compliance/sse` |
| `networking-mesh` | Network | `${TCS_AGENTIC_URL}/mcp/networking-mesh/sse` |
| `cicd-gitops` | CI/CD | `${TCS_AGENTIC_URL}/mcp/cicd-gitops/sse` |
| `observability` | Observability | `${TCS_AGENTIC_URL}/mcp/observability/sse` |
| `infrastructure-virtualization` | Infrastructure | `${TCS_AGENTIC_URL}/mcp/infrastructure-virtualization/sse` |
| `proactive-intelligence` | Proactive | `${TCS_AGENTIC_URL}/mcp/proactive-intelligence/sse` |
| `multi-cluster-acm` | Multi-Cluster | `${TCS_AGENTIC_URL}/mcp/multi-cluster-acm/sse` |
| `<all>` | Single | `${TCS_AGENTIC_URL}/sse` |

Discover all agents at runtime:

```bash
curl ${TCS_AGENTIC_URL}/.well-known/agent.json
curl ${TCS_AGENTIC_URL}/api/agents
```

---

## Compliance with global standards

- **MCP** — Model Context Protocol (Anthropic, adopted by Microsoft, Google, AWS)
- **A2A** — Agent-to-Agent discovery (Google)
- **OpenAPI 3.1** — REST API description
- See [`openapi.yaml`](../rest-api/openapi.yaml) for full REST spec.
