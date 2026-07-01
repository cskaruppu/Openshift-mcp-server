# TCS Agentic AI — Complete Product Guide

**The autonomous SRE for Kubernetes & OpenShift.**
A single guide to explain *what it is, how it's built, how it works,* and *how it compares* — for customers, architects, and evaluators.

> One-line: TCS Agentic AI is an AI-native operations platform that **detects, diagnoses, documents, fixes, and verifies** problems across a fleet of Kubernetes/OpenShift clusters — with a human always in control and every action audited.

---

## Table of Contents
1. [Executive Summary](#1-executive-summary)
2. [What It Is](#2-what-it-is)
3. [How It's Built (Architecture)](#3-how-its-built-architecture)
4. [How It Works (Capability Walkthroughs)](#4-how-it-works-capability-walkthroughs)
5. [Complete Component Inventory](#5-complete-component-inventory)
6. [Security & Governance](#6-security--governance)
7. [Standards & Frameworks](#7-standards--frameworks)
8. [Competitive Comparison](#8-competitive-comparison)
9. [Deployment Model](#9-deployment-model)
10. [Glossary](#10-glossary)

---

## 1. Executive Summary

**The problem.** Enterprise platform teams run 10–100+ Kubernetes/OpenShift clusters with thousands of workloads. They drown in alerts, do manual triage, chase configuration drift, prepare compliance evidence by hand, and copy-paste between monitoring, ticketing, and the CLI. Mean-time-to-detect and mean-time-to-resolve stay high; audit prep takes weeks.

**The solution.** TCS Agentic AI puts an **agentic AI co-pilot** on top of the entire fleet. It continuously watches every cluster, uses an LLM to reason about what it sees, proposes precise fixes, executes them on approval, opens/closes the ITSM ticket, and proves the fix worked — end to end.

**The differentiator.** Most tools *observe and alert*. TCS Agentic AI **closes the loop**: `detect → diagnose → ticket → fix → verify → resolve`, with full traceability of what the AI did and how many tokens it used. It is **multi-cloud** (OpenShift, EKS, AKS, GKE), **governed** (human-in-the-loop, RBAC, audit trail), and **open** (built on the Model Context Protocol).

---

## 2. What It Is

A **production-grade Model Context Protocol (MCP) server** for Kubernetes/OpenShift, plus a **React operations console**, that together deliver:

| Pillar | What it does |
|---|---|
| **AI Chat & Incident Response** | Natural-language diagnostics; root-cause analysis from logs + events + metrics; one-click fixes |
| **Autonomous Remediation** | AI proposes → human approves → AI executes → verifies with before/after |
| **Security & Vulnerabilities** | Live CVE scanning (Trivy/Quay), AI-generated fixes, end-to-end remediation with ServiceNow Change Requests |
| **Compliance & Audit** | CIS Kubernetes Benchmark scoring, 90-day audit trail, agent execution traces |
| **Configuration Drift** | Real-time drift detection with one-click rollback (self-healing) |
| **Predictive Intelligence** | Risk predictions, anomaly detection, incident correlation across the fleet |
| **ITSM & Notifications** | ServiceNow Incidents/Change Requests, Slack/Teams/PagerDuty |
| **Multi-Cluster Fleet** | One pane of glass; cluster-isolated data; hub-and-spoke federation |

Scale today: **~100,000 lines of code**, **60+ backend services**, **45+ cluster tools**, **6 platform providers**, **20 dashboard widgets**.

---

## 3. How It's Built (Architecture)

### 3.1 Foundation — the Model Context Protocol (MCP)
The server speaks **MCP** (Anthropic's open standard for connecting AI models to tools/data) over both **stdio** and **SSE** transports. Every cluster capability is exposed as an MCP **tool** with a typed schema, so an LLM can call it safely. This is what makes the product *agentic* rather than a fixed dashboard: the AI orchestrates real tools.

### 3.2 Topology — one image, two roles
```
                ┌─────────────────────────────────────────────┐
                │           MANAGEMENT BUNDLE (Hub)            │
                │  React Console (Nginx)  ·  PostgreSQL · Redis│
                │  MCP Server (control) · Orchestrator · Hub   │
                └───────────────┬─────────────────────────────┘
                                │  cluster-scoped API + bridge
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
 ┌─────────────┐        ┌─────────────┐         ┌─────────────┐
 │ Spoke: OCP  │        │ Spoke: EKS  │         │ Spoke: AKS  │
 │ MCP (spoke) │        │ MCP (spoke) │         │ MCP (spoke) │
 └─────────────┘        └─────────────┘         └─────────────┘
```
- **Same container image** runs as either **control plane** (`MCP_MODE=control` — the stateful management bundle) or **stateless spoke** (`MCP_MODE=spoke`) on each cluster, including the hub itself.
- **Cluster isolation by construction:** every data query is keyed by the active cluster (`useClusterQuery`), carries a `?cluster=<id>` parameter and `X-Cluster-Context` header, and is routed to the correct spoke. One customer's cluster data never bleeds into another's view.

### 3.3 Multi-platform provider abstraction
A provider layer normalizes platform differences so the same features work everywhere:
`openshift`, `eks`, `gke`, `aks`, `vanilla-k8s`, and a `base` contract. OpenShift-specific APIs (Routes, SCC, ClusterOperators, MachineConfigPools) are used when present; cloud K8s falls back to portable equivalents.

### 3.4 Technology stack
| Layer | Technology |
|---|---|
| MCP Server / APIs | Node.js 20, `@modelcontextprotocol/sdk`, `@kubernetes/client-node` |
| AI / LLM | Pluggable providers — Anthropic Claude, Azure OpenAI, OpenAI, Google, Bedrock, Ollama |
| Console | React + Vite, TanStack Query, cluster-isolated hooks |
| State / Cache | PostgreSQL (audit, traces, memory, history), Redis (cache, cross-instance state) |
| Observability | OpenTelemetry (OTel), Prometheus queries, structured telemetry |
| ITSM / Notify | ServiceNow REST, Slack, Teams, PagerDuty, Jira, GitHub |
| Automation | Ansible, Helm, Tekton, GitOps (Argo), Velero, KubeVirt |

### 3.5 The AI reasoning layer
- **NLU** (`nlu`, `nlu-llm`) classifies intent from natural language.
- **Context gathering** pulls only the relevant cluster data, compresses it (`context-optimizer`), and builds a diagnostic brief.
- **LLM** reasons over the brief; **guardrails**, **safety**, and **redaction** services constrain and sanitize.
- **Memory** (`persistent-memory`, `episodic-memory`, `conversation-memory`) and **learning-engine**/**reflection** improve answers over time.
- **Query Tracer** records *which agents ran, which tools they called, and how many tokens they used* — full glass-box observability of the AI.

---

## 4. How It Works (Capability Walkthroughs)

### 4.1 AI Chat & Incident Response
```
"why is pod mlflow-server crashing?"
   → NLU intent: incident_response
   → parallel gather: pod spec, logs, events, metrics, deployment
   → LLM root-cause analysis (OOMKilled / CrashLoop / ImagePull / etc.)
   → severity (SEV-1…5) + evidence + fix proposals
   → auto-raise ServiceNow Incident (SEV-1/2/3)
   → user clicks Apply → patch + rolling restart
   → Before/After comparison (memory, pods, restarts)
   → auto-close Incident with RCA, timeline, prevention
```
Log fetches and the ServiceNow call run **in parallel** with LLM reasoning to keep latency low.

### 4.2 Image Vulnerability Scanning → AI Fix → End-to-End Remediation
```
Scanner mode auto-detected:
   Trivy Operator (live CVE)  →  Quay/Clair  →  static hygiene fallback
   Badge shows "Live CVE · Trivy" (green) vs "Static Analysis" (amber)

Per finding:
   Severity cards are clickable filters (Critical/High/Medium/Low/Exploitable)
   KEV badge = actively-exploited (CISA KEV); EXPLOIT = CVSS ≥ 9
   🪄 AI Fix → recommended patched image/tag + oc command + Dockerfile patch
   ▷ Dry Run → preview (old→new image, backout command) — no change
   ▶ Apply & Raise CR → ServiceNow Change Request (Incident too if KEV)
       → patch deployment image (strategic-merge, container-safe)
       → re-scan → before/after CVE delta → close CR with evidence
```
This is the **world-class differentiator**: no scanner on the market performs *detect → AI-fix → governed apply → re-scan → auto-audit* across multi-cloud clusters.

### 4.3 Configuration Drift Detection & One-Click Rollback
```
Baseline captured per workload (generation + resourceVersion aware)
   → background agent re-scans every 1–5 min
   → out-of-GitOps change flagged in real time (App Changes widget)
   → AI explains old-vs-new spec in plain English + timestamp
   → Acknowledge / Agree / Dismiss & Rollback
   → Rollback = strategic-merge patch restoring full container spec
   → card marked "DISMISSED — ROLLED BACK"; audit entry written
```
Self-healing infrastructure, demonstrated live.

### 4.4 Compliance, Audit & Agent Traces
- **CIS Kubernetes Benchmark** scan with grade + findings by severity.
- **90-day persistent audit trail** of every compliance/security event.
- **Agent Execution Traces** — for each AI Chat request: which agents fired, which tools they called, per-span duration, and **token consumption per agent** (glass-box governance).

### 4.5 Predictive Intelligence
Risk predictions, anomaly detection, incident correlation, and knowledge-base retrieval (RAG) — moving teams from *reactive* to *proactive*.

### 4.6 ITSM Integration (ServiceNow)
- **Incidents** for reactive problems (pod crash, exploited CVE).
- **Change Requests** for planned fixes (image patch) — correct ITIL modeling with implementation + backout + test plans.
- Resilient client: PATCH→PUT fallback, state-transition stepping (New→In Progress→Resolved), best-effort close that never loses saved evidence.

---

## 5. Complete Component Inventory

### 5.1 Backend services (60+)
**AI & reasoning:** chat-api, nlu, nlu-llm, llm, reasoning, reflection, learning-engine, task-planner, agent-loop, few-shot-examples, context-optimizer, summarizer.
**Memory & knowledge:** persistent-memory, episodic-memory, conversation-memory, knowledge-base, incident-rag, error-knowledge, resource-index.
**Operations:** incident-manager, pod-doctor, rca-engine (tool), fix-executor, action-workflow, deployment-orchestrator, upgrade-orchestrator, upgrade-report, playbooks, automation-rules, scheduler, approval-chains.
**Fleet & MCP:** mcp-hub, mcp-orchestrator, multi-cluster, cross-cluster-correlation, agent-bridge, spoke-proxy, tools-registry.
**Security & governance:** guardrails, safety, redaction, auth, rate-limit, audit-log, query-tracer, feature-flags.
**Telemetry:** telemetry, otel, metrics, prometheus, alertmanager, predictive-intel.
**Integrations:** integrations (Slack/Teams/PagerDuty/Jira/GitHub), notifications, cr-tracker, change-timeline, cost-advisor, chatops.

### 5.2 Cluster tools (45+)
cluster, nodes, pods, workloads, namespaces, diagnostics, metrics-top, capacity-forecast, network, network-topology, security, scc-advisor, policy-engine, policy-gen, compliance, compliance-scanner, compliance-frameworks, benchmarks, **image-vulnerability-scanner**, drift, app-change-watcher, gitops, helm, tekton, ansible, velero, kubevirt, ossm, acm, operator-diag, upgrade-advisor, upgrade-preflight, slo-tracker, rca-engine, recommendations, impact, timeline, mustgather, provisioning, emergency, deploy-from-doc, prometheus-query, notifications, servicenow.

### 5.3 Dashboard (React console)
**Views:** Dashboard, AI Chat, Audit, AI Intelligence, Cluster Picker, AI Hub.
**Widgets (20):** Cluster Health, Nodes, Pods, Namespaces, Cluster Operators, Active Alerts, Pods at Risk, Score, Risk Predictions, **Image Vulns**, App Changes, Capacity, Resource Optimization, Health Timeline, Node Topology, Namespace Heatmap, Emergency Actions, Multicluster, Ansible.

### 5.4 Platform providers
openshift · eks · gke · aks · vanilla-k8s (+ base contract).

---

## 6. Security & Governance

- **Human-in-the-loop:** the AI proposes; a human approves; the AI executes. Nothing mutates a cluster without an explicit click (and a confirm dialog for high-impact actions).
- **Least-privilege RBAC:** the server runs under a read-mostly ClusterRole; mutations go through specific, audited actions.
- **Guardrails & safety:** command validation, redaction of secrets from prompts/logs, rate limiting.
- **Full audit:** 90-day audit trail + agent execution traces (with token accounting) + ServiceNow tickets = complete, exportable evidence.
- **Cluster isolation:** data is partitioned per cluster by construction.

---

## 7. Standards & Frameworks

CIS Kubernetes Benchmark · NIST SP 800-190 (container security) · NSA/CISA Kubernetes Hardening Guide · CVSS v3.1 · CISA KEV · EPSS · SLSA · Sigstore/cosign · SPDX/CycloneDX (SBOM) · ITIL (Incident vs Change) · Model Context Protocol · OpenTelemetry.

---

## 8. Competitive Comparison

### 8.1 Where TCS Agentic AI sits
It spans three categories that customers usually buy separately — **AIOps/observability**, **container security**, and **ITSM automation** — and unifies them with an *agentic* AI that acts, not just alerts.

### 8.2 Feature matrix

| Capability | TCS Agentic AI | Datadog / Dynatrace (AIOps) | Prisma / Aqua (Container Security) | Red Hat ACM + ACS | Native OpenShift / kubectl |
|---|:--:|:--:|:--:|:--:|:--:|
| Natural-language ops (chat) | ✅ | Partial | ❌ | ❌ | ❌ |
| LLM root-cause analysis | ✅ | Partial | ❌ | ❌ | ❌ |
| **AI-generated fix + one-click apply** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Closed-loop auto-remediation + verify** | ✅ | ❌ | ❌ | Partial | ❌ |
| Live CVE image scanning | ✅ (Trivy/Quay) | Partial | ✅ | ✅ (ACS) | ❌ |
| **AI remediation of CVEs + ITSM CR** | ✅ | ❌ | ❌ | ❌ | ❌ |
| Config drift + one-click rollback | ✅ | ❌ | ❌ | Partial (policy) | ❌ |
| CIS compliance + audit trail | ✅ | Partial | ✅ | ✅ | ❌ |
| **Agent trace + token governance** | ✅ | ❌ | ❌ | ❌ | ❌ |
| ServiceNow Incident + Change Request | ✅ | Partial | ❌ | ❌ | ❌ |
| Multi-cloud (OCP/EKS/AKS/GKE) | ✅ | ✅ | ✅ | Partial | ✅ |
| Open protocol (MCP), no lock-in | ✅ | ❌ | ❌ | ❌ | ✅ |
| Self-hostable, data stays in-cluster | ✅ | ❌ (SaaS) | Partial | ✅ | ✅ |

### 8.3 Narrative positioning
- **vs Datadog/Dynatrace:** they excel at *observing* and correlating; they don't *fix*. TCS Agentic AI turns a diagnosis into an applied, verified, audited remediation.
- **vs Prisma/Aqua/ACS:** best-in-class scanners that *report and rank*. TCS Agentic AI adds the AI that *generates the fix, applies it via a governed Change Request, and re-scans to prove it*.
- **vs Red Hat ACM/ACS:** strong fleet + policy + security for OpenShift, but not conversational, not LLM-driven, and OpenShift-centric. TCS Agentic AI is AI-native and multi-cloud.
- **vs native tooling:** the CLI can do anything — for one expert, one cluster, one problem at a time. TCS Agentic AI scales that expertise across the fleet with governance.

**The one-liner for customers:** *"Everyone else hands your team more dashboards and more findings. We hand them the fix — generated by AI, applied with approval, proven by re-scan, and documented in ServiceNow — across every cluster you run."*

---

## 9. Deployment Model

- **Management Bundle (hub):** React console (Nginx) + PostgreSQL + Redis + MCP control server. Deployed once.
- **Spoke:** one stateless MCP server pod per cluster (same image, `MCP_MODE=spoke`).
- **Images:** server (`Dockerfile`) and console (`console/Dockerfile`), Node 20 Alpine, non-root.
- **Manifests:** `deploy/dashboard/manifests/` (namespace, SA + least-privilege ClusterRole, deployments, routes, network policy) and `deploy/trivy-operator/` (optional live-CVE enablement).
- **Config:** LLM provider, ServiceNow, notifications, and cluster credentials are set via the console Settings panel or environment — read at runtime, no rebuild required.

---

## 10. Glossary

**MCP** — Model Context Protocol; open standard letting an LLM call typed tools.
**Spoke** — stateless MCP pod on a managed cluster.
**Management Bundle** — the stateful hub (console + DB + cache + control server).
**Agentic AI** — AI that autonomously plans and executes multi-step tasks via tools, under governance.
**KEV** — CISA Known Exploited Vulnerabilities catalog.
**EPSS** — Exploit Prediction Scoring System (probability a CVE will be exploited).
**CR / INC** — ServiceNow Change Request / Incident.
**Drift** — configuration change made outside the approved GitOps pipeline.

---

*© TCS Agentic AI. This guide reflects the current build. For live use-case decks (drift detection, incident response, upgrade automation) see the other files in `docs/`.*
