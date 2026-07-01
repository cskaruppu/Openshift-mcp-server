// Generates docs/TCS-Agentic-AI-Product-Explainer.docx — a shareable, customer-
// facing guide (what/how-built/how-works/comparison). Run: node docs/gen-product-explainer-doc.js
import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, WidthType, BorderStyle, AlignmentType, PageBreak, VerticalAlign } from "docx";
import { writeFile } from "node:fs/promises";

const C = {
  navy: "1e3a5f", blue: "2563eb", blueBg: "DBEAFE", green: "15803d", greenBg: "D1FAE5",
  orange: "C2410C", orangeBg: "FFEDD5", purple: "7C3AED", purpleBg: "EDE9FE",
  red: "DC2626", teal: "0D9488", gray: "6B7280", grayBorder: "D1D5DB",
  headerBg: "1e3a5f", white: "FFFFFF", black: "111827",
};
const thin = { style: BorderStyle.SINGLE, size: 1, color: C.grayBorder };
const cellBorders = { top: thin, bottom: thin, left: thin, right: thin };

function h(text, level = 1) {
  return new Paragraph({ text, heading: { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 }[level], spacing: { before: 280, after: 100 } });
}
function p(text, o = {}) {
  return new Paragraph({ children: [new TextRun({ text, bold: o.bold, italics: o.italic, size: o.size || 21, color: o.color, font: "Calibri" })], spacing: { after: o.after ?? 100, before: o.before || 0 }, alignment: o.align });
}
function bullet(text, o = {}) {
  return new Paragraph({ children: [new TextRun({ text, bold: o.bold, size: 21, color: o.color })], bullet: { level: o.level || 0 }, spacing: { after: 40 } });
}
function mono(text) {
  return new Paragraph({ children: [new TextRun({ text, font: "Consolas", size: 18, color: C.navy })], shading: { fill: "F3F4F6" }, spacing: { after: 30, before: 20 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: C.blue } } });
}
function cell(text, o = {}) {
  return new TableCell({
    children: (Array.isArray(text) ? text : [text]).map(t => new Paragraph({ children: [new TextRun({ text: String(t), bold: o.bold, size: o.size || 18, color: o.color || (o.header ? C.white : C.black) })], alignment: o.align || AlignmentType.LEFT })),
    shading: o.fill ? { fill: o.fill } : undefined, borders: cellBorders, verticalAlign: VerticalAlign.CENTER, width: o.width ? { size: o.width, type: WidthType.PERCENTAGE } : undefined, margins: { top: 40, bottom: 40, left: 80, right: 80 },
  });
}
function table(headers, rows, widths) {
  const head = new TableRow({ children: headers.map((hd, i) => cell(hd, { header: true, bold: true, fill: C.headerBg, align: i === 0 ? AlignmentType.LEFT : AlignmentType.CENTER, width: widths?.[i] })), tableHeader: true });
  const body = rows.map((r, ri) => new TableRow({ children: r.map((c, i) => cell(c, { align: i === 0 ? AlignmentType.LEFT : AlignmentType.CENTER, fill: ri % 2 ? "F9FAFB" : undefined, width: widths?.[i] })) }));
  return new Table({ rows: [head, ...body], width: { size: 100, type: WidthType.PERCENTAGE } });
}

const children = [];

// ---- Cover ----
children.push(new Paragraph({ text: "", spacing: { before: 1600 } }));
children.push(new Paragraph({ children: [new TextRun({ text: "TCS Agentic AI", bold: true, size: 64, color: C.navy })], alignment: AlignmentType.CENTER, spacing: { after: 80 } }));
children.push(new Paragraph({ children: [new TextRun({ text: "Complete Product Guide", size: 34, color: C.blue })], alignment: AlignmentType.CENTER, spacing: { after: 60 } }));
children.push(new Paragraph({ children: [new TextRun({ text: "The Autonomous SRE for Kubernetes & OpenShift", italics: true, size: 24, color: C.gray })], alignment: AlignmentType.CENTER, spacing: { after: 400 } }));
children.push(new Paragraph({ children: [new TextRun({ text: "What it is · How it's built · How it works · How it compares", size: 20, color: C.teal })], alignment: AlignmentType.CENTER }));
children.push(new Paragraph({ children: [new PageBreak()] }));

// ---- 1. Executive Summary ----
children.push(h("1. Executive Summary", 1));
children.push(p("The problem.", { bold: true }));
children.push(p("Enterprise platform teams run 10–100+ Kubernetes/OpenShift clusters with thousands of workloads. They drown in alerts, do manual triage, chase configuration drift, prepare compliance evidence by hand, and copy-paste between monitoring, ticketing, and the CLI. MTTD and MTTR stay high; audit prep takes weeks."));
children.push(p("The solution.", { bold: true }));
children.push(p("TCS Agentic AI puts an agentic AI co-pilot on top of the entire fleet. It continuously watches every cluster, uses an LLM to reason about what it sees, proposes precise fixes, executes them on approval, opens/closes the ITSM ticket, and proves the fix worked — end to end."));
children.push(p("The differentiator.", { bold: true }));
children.push(p("Most tools observe and alert. TCS Agentic AI closes the loop: detect → diagnose → ticket → fix → verify → resolve — with full traceability of what the AI did and how many tokens it used. It is multi-cloud (OpenShift, EKS, AKS, GKE), governed (human-in-the-loop, RBAC, audit trail), and open (built on the Model Context Protocol)."));

// ---- 2. What It Is ----
children.push(h("2. What It Is", 1));
children.push(p("A production-grade Model Context Protocol (MCP) server for Kubernetes/OpenShift, plus a React operations console, delivering eight pillars:"));
children.push(table(["Pillar", "What it does"], [
  ["AI Chat & Incident Response", "NL diagnostics; RCA from logs+events+metrics; one-click fixes"],
  ["Autonomous Remediation", "AI proposes → human approves → AI executes → verifies"],
  ["Security & Vulnerabilities", "Live CVE scanning (Trivy/Quay), AI fixes, end-to-end remediation with ServiceNow CRs"],
  ["Compliance & Audit", "CIS Benchmark scoring, 90-day audit trail, agent execution traces"],
  ["Configuration Drift", "Real-time detection + one-click rollback (self-healing)"],
  ["Predictive Intelligence", "Risk predictions, anomaly detection, incident correlation"],
  ["ITSM & Notifications", "ServiceNow Incidents/Changes, Slack/Teams/PagerDuty"],
  ["Multi-Cluster Fleet", "One pane of glass; cluster-isolated data; hub-and-spoke"],
], [34, 66]));
children.push(p("", { after: 80 }));
children.push(p("Scale: ~100,000 lines of code · 60+ backend services · 45+ cluster tools · 6 platform providers · 20 dashboard widgets.", { bold: true, color: C.navy }));

// ---- 3. How It's Built ----
children.push(new Paragraph({ children: [new PageBreak()] }));
children.push(h("3. How It's Built (Architecture)", 1));
children.push(h("3.1 Foundation — Model Context Protocol (MCP)", 2));
children.push(p("The server speaks MCP (an open standard for connecting AI models to tools/data) over stdio and SSE. Every cluster capability is a typed MCP tool an LLM can call safely — this is what makes the product agentic rather than a fixed dashboard."));
children.push(h("3.2 Topology — one image, two roles", 2));
children.push(mono("MANAGEMENT BUNDLE (Hub): React Console (Nginx) · PostgreSQL · Redis · MCP control server"));
children.push(mono("SPOKES: one stateless MCP pod per cluster (OCP / EKS / AKS / GKE) — same image, MCP_MODE=spoke"));
children.push(bullet("Same container image runs as control plane (stateful hub) or stateless spoke on each cluster, including the hub."));
children.push(bullet("Cluster isolation by construction: every query is keyed by active cluster, carries ?cluster=<id> + X-Cluster-Context, and routes to the correct spoke."));
children.push(h("3.3 Multi-platform provider abstraction", 2));
children.push(p("A provider layer normalizes platform differences: openshift, eks, gke, aks, vanilla-k8s (+ base contract). OpenShift APIs (Routes, SCC, ClusterOperators, MCPs) are used when present; cloud K8s falls back to portable equivalents."));
children.push(h("3.4 Technology stack", 2));
children.push(table(["Layer", "Technology"], [
  ["MCP Server / APIs", "Node.js 20, @modelcontextprotocol/sdk, @kubernetes/client-node"],
  ["AI / LLM", "Pluggable — Claude, Azure OpenAI, OpenAI, Google, Bedrock, Ollama"],
  ["Console", "React + Vite, TanStack Query, cluster-isolated hooks"],
  ["State / Cache", "PostgreSQL (audit, traces, memory), Redis (cache, state)"],
  ["Observability", "OpenTelemetry, Prometheus, structured telemetry"],
  ["ITSM / Notify", "ServiceNow REST, Slack, Teams, PagerDuty, Jira, GitHub"],
  ["Automation", "Ansible, Helm, Tekton, GitOps (Argo), Velero, KubeVirt"],
], [28, 72]));
children.push(h("3.5 The AI reasoning layer", 2));
children.push(bullet("NLU classifies intent → context gathering pulls only relevant data → context-optimizer compresses it."));
children.push(bullet("LLM reasons over a diagnostic brief; guardrails, safety, and redaction constrain and sanitize."));
children.push(bullet("Memory (persistent/episodic/conversation) + learning-engine/reflection improve answers over time."));
children.push(bullet("Query Tracer records which agents ran, which tools they called, and tokens used — glass-box observability."));

// ---- 4. How It Works ----
children.push(new Paragraph({ children: [new PageBreak()] }));
children.push(h("4. How It Works (Capability Walkthroughs)", 1));
children.push(h("4.1 AI Chat & Incident Response", 2));
children.push(mono('"why is pod X crashing?" → intent: incident_response → parallel gather (spec, logs, events, metrics)'));
children.push(mono("→ LLM root-cause + severity + fix proposals → auto-raise ServiceNow Incident → Apply → Before/After → auto-close"));
children.push(p("Log fetches and the ServiceNow call run in parallel with LLM reasoning to keep latency low."));
children.push(h("4.2 Vulnerability Scanning → AI Fix → End-to-End Remediation", 2));
children.push(mono("Scanner auto-detected: Trivy (live CVE) → Quay/Clair → static fallback. Badge: 'Live CVE · Trivy' vs 'Static Analysis'"));
children.push(mono("Per finding: KEV/EXPLOIT badges → 🪄 AI Fix (patched tag + oc cmd) → ▷ Dry Run → ▶ Apply & Raise CR → re-scan → close CR"));
children.push(p("The world-class differentiator: no scanner performs detect → AI-fix → governed apply → re-scan → auto-audit across multi-cloud clusters.", { bold: true, color: C.navy }));
children.push(h("4.3 Configuration Drift Detection & One-Click Rollback", 2));
children.push(mono("Baseline per workload → agent re-scans every 1–5 min → out-of-GitOps change flagged → AI explains old-vs-new"));
children.push(mono("→ Dismiss & Rollback = strategic-merge patch restoring full spec → 'DISMISSED — ROLLED BACK' → audit entry"));
children.push(h("4.4 Compliance, Audit & Agent Traces", 2));
children.push(bullet("CIS Kubernetes Benchmark scan with grade + findings by severity."));
children.push(bullet("90-day persistent audit trail of every compliance/security event."));
children.push(bullet("Agent Execution Traces: per request, which agents fired, tools called, duration, and token consumption per agent."));
children.push(h("4.5 ITSM Integration (ServiceNow)", 2));
children.push(bullet("Incidents for reactive problems; Change Requests for planned fixes (correct ITIL modeling with backout plans)."));
children.push(bullet("Resilient client: PATCH→PUT fallback, New→In Progress→Resolved stepping, best-effort close that never loses evidence."));

// ---- 5. Components ----
children.push(new Paragraph({ children: [new PageBreak()] }));
children.push(h("5. Complete Component Inventory", 1));
children.push(p("Backend services (60+):", { bold: true }));
children.push(p("AI/reasoning (chat-api, nlu, llm, reasoning, reflection, learning-engine, task-planner, agent-loop, context-optimizer); Memory/knowledge (persistent/episodic/conversation memory, knowledge-base, incident-rag, error-knowledge); Operations (incident-manager, pod-doctor, fix-executor, action-workflow, deployment/upgrade-orchestrator, playbooks, automation-rules, scheduler, approval-chains); Fleet/MCP (mcp-hub, mcp-orchestrator, multi-cluster, cross-cluster-correlation, agent-bridge, spoke-proxy); Security/governance (guardrails, safety, redaction, auth, rate-limit, audit-log, query-tracer); Telemetry (telemetry, otel, metrics, prometheus, alertmanager, predictive-intel); Integrations (Slack/Teams/PagerDuty/Jira/GitHub, notifications, cr-tracker, cost-advisor)."));
children.push(p("Cluster tools (45+):", { bold: true }));
children.push(p("cluster, nodes, pods, workloads, namespaces, diagnostics, capacity-forecast, network(-topology), security, scc-advisor, policy-engine/gen, compliance(-scanner/-frameworks), benchmarks, image-vulnerability-scanner, drift, app-change-watcher, gitops, helm, tekton, ansible, velero, kubevirt, ossm, acm, operator-diag, upgrade-advisor/-preflight, slo-tracker, rca-engine, recommendations, impact, timeline, mustgather, provisioning, emergency, deploy-from-doc, prometheus-query, servicenow."));
children.push(p("Dashboard:", { bold: true }));
children.push(p("Views — Dashboard, AI Chat, Audit, AI Intelligence, Cluster Picker, AI Hub. Widgets (20) — Cluster Health, Nodes, Pods, Namespaces, Cluster Operators, Active Alerts, Pods at Risk, Score, Risk Predictions, Image Vulns, App Changes, Capacity, Resource Optimization, Health Timeline, Node Topology, Namespace Heatmap, Emergency Actions, Multicluster, Ansible."));
children.push(p("Platform providers:", { bold: true }));
children.push(p("openshift · eks · gke · aks · vanilla-k8s (+ base contract)."));

// ---- 6. Security & 7. Standards ----
children.push(h("6. Security & Governance", 1));
children.push(bullet("Human-in-the-loop: AI proposes, human approves, AI executes. Nothing mutates a cluster without an explicit click."));
children.push(bullet("Least-privilege RBAC: read-mostly ClusterRole; mutations via specific, audited actions."));
children.push(bullet("Guardrails & safety: command validation, secret redaction from prompts/logs, rate limiting."));
children.push(bullet("Full audit: 90-day trail + agent traces (token accounting) + ServiceNow tickets = exportable evidence."));
children.push(bullet("Cluster isolation: data partitioned per cluster by construction."));
children.push(h("7. Standards & Frameworks", 1));
children.push(p("CIS Kubernetes Benchmark · NIST SP 800-190 · NSA/CISA Kubernetes Hardening Guide · CVSS v3.1 · CISA KEV · EPSS · SLSA · Sigstore/cosign · SPDX/CycloneDX (SBOM) · ITIL (Incident vs Change) · Model Context Protocol · OpenTelemetry."));

// ---- 8. Comparison ----
children.push(new Paragraph({ children: [new PageBreak()] }));
children.push(h("8. Competitive Comparison", 1));
children.push(p("TCS Agentic AI spans three categories customers usually buy separately — AIOps/observability, container security, and ITSM automation — and unifies them with an agentic AI that acts, not just alerts."));
children.push(table(
  ["Capability", "TCS Agentic AI", "Datadog / Dynatrace", "Prisma / Aqua", "Red Hat ACM+ACS", "Native / kubectl"],
  [
    ["NL ops (chat)", "Yes", "Partial", "No", "No", "No"],
    ["LLM root-cause analysis", "Yes", "Partial", "No", "No", "No"],
    ["AI fix + one-click apply", "Yes", "No", "No", "No", "No"],
    ["Closed-loop auto-remediate + verify", "Yes", "No", "No", "Partial", "No"],
    ["Live CVE image scanning", "Yes", "Partial", "Yes", "Yes", "No"],
    ["AI CVE remediation + ITSM CR", "Yes", "No", "No", "No", "No"],
    ["Drift + one-click rollback", "Yes", "No", "No", "Partial", "No"],
    ["CIS compliance + audit trail", "Yes", "Partial", "Yes", "Yes", "No"],
    ["Agent trace + token governance", "Yes", "No", "No", "No", "No"],
    ["ServiceNow Incident + Change", "Yes", "Partial", "No", "No", "No"],
    ["Multi-cloud (OCP/EKS/AKS/GKE)", "Yes", "Yes", "Yes", "Partial", "Yes"],
    ["Open protocol (MCP), no lock-in", "Yes", "No", "No", "No", "Yes"],
    ["Self-hosted, data in-cluster", "Yes", "No", "Partial", "Yes", "Yes"],
  ],
  [26, 16, 16, 14, 14, 14]
));
children.push(p("", { after: 60 }));
children.push(p("Positioning", { bold: true, color: C.navy }));
children.push(bullet("vs Datadog/Dynatrace: they observe and correlate; they don't fix. We turn a diagnosis into an applied, verified, audited remediation."));
children.push(bullet("vs Prisma/Aqua/ACS: best-in-class scanners that report and rank. We add the AI that generates the fix, applies it via a governed Change Request, and re-scans to prove it."));
children.push(bullet("vs Red Hat ACM/ACS: strong fleet/policy/security for OpenShift, but not conversational, not LLM-driven, OpenShift-centric. We are AI-native and multi-cloud."));
children.push(bullet("vs native tooling: the CLI can do anything — for one expert, one cluster, one problem. We scale that expertise across the fleet with governance."));
children.push(p("Customer one-liner: \"Everyone else hands your team more dashboards and more findings. We hand them the fix — generated by AI, applied with approval, proven by re-scan, and documented in ServiceNow — across every cluster you run.\"", { italic: true, bold: true, color: C.navy, before: 100 }));

// ---- 9. Deployment ----
children.push(h("9. Deployment Model", 1));
children.push(bullet("Management Bundle (hub): React console (Nginx) + PostgreSQL + Redis + MCP control server. Deployed once."));
children.push(bullet("Spoke: one stateless MCP pod per cluster (same image, MCP_MODE=spoke)."));
children.push(bullet("Images: server + console, Node 20 Alpine, non-root."));
children.push(bullet("Manifests: deploy/dashboard/manifests/ (SA + least-privilege ClusterRole, deployments, routes, netpol) and deploy/trivy-operator/ (optional live-CVE)."));
children.push(bullet("Config: LLM provider, ServiceNow, notifications, cluster credentials set via Settings or env — read at runtime, no rebuild."));

children.push(p("", { before: 200 }));
children.push(p("© TCS Agentic AI — this guide reflects the current build.", { italic: true, color: C.gray, align: AlignmentType.CENTER }));

const doc = new Document({
  styles: { default: {
    heading1: { run: { size: 30, bold: true, color: C.navy }, paragraph: { spacing: { before: 280, after: 120 } } },
    heading2: { run: { size: 24, bold: true, color: C.blue }, paragraph: { spacing: { before: 200, after: 80 } } },
  } },
  sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 1000, right: 1000 } } }, children }],
});

const buf = await Packer.toBuffer(doc);
await writeFile("docs/TCS-Agentic-AI-Product-Explainer.docx", buf);
console.log("Written: docs/TCS-Agentic-AI-Product-Explainer.docx");
