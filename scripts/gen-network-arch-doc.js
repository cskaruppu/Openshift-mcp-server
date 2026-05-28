import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, WidthType, BorderStyle, AlignmentType, PageBreak } from "docx";
import { writeFile } from "node:fs/promises";

function heading(text, level) {
  const map = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 };
  return new Paragraph({ text, heading: map[level] || HeadingLevel.HEADING_1, spacing: { before: 300, after: 100 } });
}

function para(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, bold: opts.bold, italics: opts.italic, size: opts.size || 22, font: opts.font })],
    spacing: { after: opts.after || 80 },
    alignment: opts.align,
  });
}

function bulletPara(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, bold: opts.bold, size: 22 })],
    bullet: { level: opts.level || 0 },
    spacing: { after: 40 },
  });
}

const borderStyle = { style: BorderStyle.SINGLE, size: 1, color: "999999" };
const borders = { top: borderStyle, bottom: borderStyle, left: borderStyle, right: borderStyle };
const headerBorders = { top: borderStyle, bottom: { style: BorderStyle.SINGLE, size: 2, color: "1e3a5f" }, left: borderStyle, right: borderStyle };

function cell(text, opts = {}) {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold: opts.bold, size: opts.size || 20, color: opts.color, font: "Calibri" })], alignment: opts.align })],
    width: { size: opts.width || 50, type: WidthType.PERCENTAGE },
    borders: opts.header ? headerBorders : borders,
    shading: opts.shading ? { fill: opts.shading } : undefined,
  });
}

function dataTable(headers, dataRows, colWidths) {
  const w = colWidths || headers.map(() => Math.floor(100 / headers.length));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: headers.map((h, i) => cell(h, { bold: true, width: w[i], header: true, shading: "1e3a5f", color: "FFFFFF" })) }),
      ...dataRows.map((row) => new TableRow({ children: row.map((c, i) => cell(c, { width: w[i] })) })),
    ],
  });
}

function kvTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [cell("Parameter", { bold: true, width: 35, header: true, shading: "1e3a5f", color: "FFFFFF" }), cell("Value", { bold: true, width: 65, header: true, shading: "1e3a5f", color: "FFFFFF" })] }),
      ...rows.map(([k, v]) => new TableRow({ children: [cell(k, { width: 35, bold: true }), cell(v, { width: 65 })] })),
    ],
  });
}

function monoBlock(lines) {
  return lines.map((line) =>
    new Paragraph({
      children: [new TextRun({ text: line, font: "Courier New", size: 18 })],
      spacing: { after: 0 },
    })
  );
}

const doc = new Document({
  styles: {
    default: {
      document: { run: { font: "Calibri", size: 22 } },
    },
  },
  sections: [{
    properties: {
      page: {
        margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
      },
    },
    children: [
      // ═══════════════════════════════════════════════════════════════
      // COVER PAGE
      // ═══════════════════════════════════════════════════════════════
      new Paragraph({ spacing: { before: 3000 } }),
      para("TCS KubeNexus AI", { bold: true, size: 52, align: AlignmentType.CENTER }),
      para("Multi-Cluster Network Architecture", { bold: true, size: 36, align: AlignmentType.CENTER }),
      new Paragraph({ spacing: { before: 400 } }),
      para("SNO Hub + 3-Node Agent Cluster Connectivity", { size: 28, align: AlignmentType.CENTER, italic: true }),
      new Paragraph({ spacing: { before: 600 } }),
      para("Prepared for: Network Engineering Team", { size: 22, align: AlignmentType.CENTER }),
      para("Date: " + new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }), { size: 22, align: AlignmentType.CENTER }),
      para("Classification: Internal — Infrastructure", { size: 22, align: AlignmentType.CENTER, italic: true }),
      new Paragraph({ spacing: { before: 800 } }),
      para("Document Version: 1.0", { size: 20, align: AlignmentType.CENTER }),

      // ═══════════════════════════════════════════════════════════════
      // TABLE OF CONTENTS
      // ═══════════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("Table of Contents", 1),
      para("1. Executive Summary"),
      para("2. Current Environment"),
      para("3. Architecture Overview"),
      para("4. Architecture Diagram"),
      para("5. Network Connectivity Requirements"),
      para("6. Firewall Rules Matrix"),
      para("7. DNS Requirements"),
      para("8. TLS / Certificate Requirements"),
      para("9. Agent Communication Protocol"),
      para("10. Deployment Topology"),
      para("11. Bandwidth & Performance Requirements"),
      para("12. Security Considerations"),
      para("13. Validation & Testing Plan"),
      para("14. Appendix A — Port Reference"),
      para("15. Appendix B — Architecture Diagram (Text)"),

      // ═══════════════════════════════════════════════════════════════
      // 1. EXECUTIVE SUMMARY
      // ═══════════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("1. Executive Summary", 1),
      para("This document outlines the network architecture and connectivity requirements for extending the TCS KubeNexus AI platform from a Single Node OpenShift (SNO) deployment to a multi-cluster configuration. The existing SNO cluster (10.131.71.72) serves as the central Hub, and a new 3-node OpenShift cluster (10.131.73.21-23) will be onboarded as a managed Agent cluster.", { after: 120 }),
      para("The Agent cluster runs a lightweight monitoring agent that periodically reports cluster state (nodes, pods, deployments, events) to the Hub over standard HTTP. The Hub then provides unified visibility, AI-powered diagnostics, and operational management across both clusters through a single dashboard.", { after: 120 }),
      para("Key connectivity requirement: The Agent cluster must be able to reach the Hub's API endpoint (TCP port 3000) over HTTP/HTTPS. The Hub must be able to reach the Agent cluster's Kubernetes API (TCP port 6443) for on-demand health probes and remote operations.", { after: 120 }),

      // ═══════════════════════════════════════════════════════════════
      // 2. CURRENT ENVIRONMENT
      // ═══════════════════════════════════════════════════════════════
      heading("2. Current Environment", 1),

      heading("2.1 SNO Hub Cluster (Existing)", 2),
      kvTable([
        ["Cluster Type", "Single Node OpenShift (SNO)"],
        ["Node IP", "10.131.71.72"],
        ["Role", "MCP Hub — central management plane"],
        ["OpenShift Version", "4.x (current)"],
        ["Namespace", "openshift-mcp"],
        ["MCP Server Pod Port", "3000 (MCP_SERVER_PORT)"],
        ["Exposed via", "OpenShift Route (HTTPS, TLS edge termination)"],
        ["Components", "MCP Server, Dashboard, AI Chat, Multi-Cluster Hub, PostgreSQL (optional)"],
      ]),

      heading("2.2 3-Node Agent Cluster (New)", 2),
      kvTable([
        ["Cluster Type", "3-Node OpenShift Cluster (HA)"],
        ["Control Plane / Master", "10.131.73.21"],
        ["Worker Node 1", "10.131.73.22"],
        ["Worker Node 2", "10.131.73.23"],
        ["Role", "Managed Agent — reports cluster state to Hub"],
        ["OpenShift Version", "4.x (to be deployed)"],
        ["Agent Namespace", "openshift-mcp-agent"],
        ["Agent Pod Port", "8080 (health/status endpoints)"],
        ["Kubernetes API", "https://api.<cluster>:6443"],
      ]),

      // ═══════════════════════════════════════════════════════════════
      // 3. ARCHITECTURE OVERVIEW
      // ═══════════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("3. Architecture Overview", 1),
      para("The multi-cluster architecture follows a Hub-and-Spoke model:", { after: 120 }),
      bulletPara("Hub (SNO 10.131.71.72): Runs the TCS KubeNexus AI MCP Server. Hosts the unified dashboard, AI chat, and all management tools. Accepts agent registrations and reports from remote clusters.", { bold: false }),
      bulletPara("Agent (3-Node Cluster): Runs a lightweight agent pod that scans the local cluster every 60 seconds and pushes reports (nodes, pods, deployments, events, metrics) to the Hub via HTTP POST.", { bold: false }),
      bulletPara("Communication is agent-initiated (outbound from agent to hub). The Hub never initiates connections to the agent pod. Hub does make optional health probes to the remote cluster's Kubernetes API.", { bold: false }),
      bulletPara("All communication uses standard HTTP/HTTPS over TCP. No special protocols, message queues, or VPNs are required.", { bold: false }),

      para("Data Flow Summary:", { bold: true, after: 60 }),
      bulletPara("Agent → Hub: HTTP POST to /api/agent/register (once on startup) and /api/agent/report (every 60s)"),
      bulletPara("Hub → Agent Cluster API: HTTPS GET to Kubernetes API (port 6443) for on-demand health probes, remote queries"),
      bulletPara("Browser → Hub: HTTPS to OpenShift Route for dashboard access"),

      // ═══════════════════════════════════════════════════════════════
      // 4. ARCHITECTURE DIAGRAM
      // ═══════════════════════════════════════════════════════════════
      heading("4. Architecture Diagram", 1),
      para("Below is the logical network architecture diagram showing all components and communication paths:", { after: 120 }),

      ...monoBlock([
        "┌──────────────────────────────────────────────────────────────────────────────────────────────┐",
        "│                                    NETWORK / FIREWALL BOUNDARY                              │",
        "│                                                                                              │",
        "│  ┌───────────────────────────────────────────────┐    ┌────────────────────────────────────┐ │",
        "│  │     SNO HUB CLUSTER (10.131.71.72)            │    │  3-NODE AGENT CLUSTER              │ │",
        "│  │     ──────────────────────────────             │    │  ────────────────────              │ │",
        "│  │                                               │    │                                    │ │",
        "│  │  ┌─────────────────────────────────┐          │    │  ┌──────────────────────────────┐ │ │",
        "│  │  │  Namespace: openshift-mcp        │          │    │  │  Namespace: openshift-mcp-   │ │ │",
        "│  │  │                                  │          │    │  │             agent             │ │ │",
        "│  │  │  ┌──────────────────────────┐   │          │    │  │                              │ │ │",
        "│  │  │  │   MCP Server (Hub)       │   │          │    │  │  ┌────────────────────────┐ │ │ │",
        "│  │  │  │   Port: 3000             │◄──┼──────────┼────┼──┼──┤  MCP Agent Pod         │ │ │ │",
        "│  │  │  │                          │   │  HTTP    │    │  │  │  Port: 8080            │ │ │ │",
        "│  │  │  │  • Dashboard             │   │  POST    │    │  │  │                        │ │ │ │",
        "│  │  │  │  • AI Chat Engine        │   │  :3000   │    │  │  │  • Scanner (60s poll)  │ │ │ │",
        "│  │  │  │  • Multi-Cluster Hub     │   │          │    │  │  │  • Reporter (→ Hub)    │ │ │ │",
        "│  │  │  │  • Agent Registry        │   │          │    │  │  │  • Health: /healthz    │ │ │ │",
        "│  │  │  │  • Deploy Orchestrator   │   │          │    │  │  └────────────────────────┘ │ │ │",
        "│  │  │  └──────────┬───────────────┘   │          │    │  │                              │ │ │",
        "│  │  │             │                    │          │    │  └──────────────────────────────┘ │ │",
        "│  │  │  ┌──────────▼───────────────┐   │          │    │                                    │ │",
        "│  │  │  │   PostgreSQL (Optional)   │   │  HTTPS   │    │  ┌──────────────────────────────┐ │ │",
        "│  │  │  │   Port: 5432             │   │  GET     │    │  │   Kubernetes API Server      │ │ │",
        "│  │  │  └──────────────────────────┘   │  :6443   │    │  │   Port: 6443                 │ │ │",
        "│  │  │                                  │──────────┼────┼──►  Master: 10.131.73.21        │ │ │",
        "│  │  └─────────────────────────────────┘          │    │  │                              │ │ │",
        "│  │                                               │    │  └──────────────────────────────┘ │ │",
        "│  │  ┌─────────────────────────────────┐          │    │                                    │ │",
        "│  │  │  OpenShift Route (HAProxy)       │          │    │  Nodes:                            │ │",
        "│  │  │  HTTPS (TLS Edge) → :3000        │          │    │    Master: 10.131.73.21           │ │",
        "│  │  │  Timeout: 600s (SSE streaming)   │          │    │    Worker1: 10.131.73.22           │ │",
        "│  │  └─────────────┬───────────────────┘          │    │    Worker2: 10.131.73.23           │ │",
        "│  │                │                               │    │                                    │ │",
        "│  └────────────────┼───────────────────────────────┘    └────────────────────────────────────┘ │",
        "│                   │                                                                          │",
        "└───────────────────┼──────────────────────────────────────────────────────────────────────────┘",
        "                    │ HTTPS (TLS)",
        "              ┌─────▼──────────────┐",
        "              │  Browser / Clients  │",
        "              │  Dashboard Access   │",
        "              └────────────────────┘",
        "",
        "LEGEND:",
        "  ◄──── HTTP POST :3000   Agent reports to Hub (every 60s)",
        "  ────► HTTPS GET :6443   Hub probes Agent cluster API (every 60s)",
        "  ─────  HTTPS (TLS)      Browser to Hub via OpenShift Route",
      ]),

      // ═══════════════════════════════════════════════════════════════
      // 5. NETWORK CONNECTIVITY REQUIREMENTS
      // ═══════════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("5. Network Connectivity Requirements", 1),
      para("The following table lists all required network flows between the two clusters. ALL flows use TCP protocol.", { after: 120 }),

      heading("5.1 Primary Flows (Required)", 2),
      dataTable(
        ["#", "Source", "Destination", "Port", "Protocol", "Direction", "Purpose"],
        [
          ["1", "Agent Pod (10.131.73.x)", "Hub SNO (10.131.71.72)", "3000/TCP", "HTTP", "Agent → Hub", "Agent registration & periodic reports"],
          ["2", "Hub SNO (10.131.71.72)", "K8s API (10.131.73.21)", "6443/TCP", "HTTPS", "Hub → Agent", "Health probes & remote cluster queries"],
          ["3", "Agent Pod (10.131.73.x)", "K8s API (10.131.73.21)", "6443/TCP", "HTTPS", "Internal", "Agent scans local cluster API"],
        ],
        [5, 17, 17, 10, 8, 13, 30]
      ),

      heading("5.2 Optional Flows", 2),
      dataTable(
        ["#", "Source", "Destination", "Port", "Protocol", "Direction", "Purpose"],
        [
          ["4", "Hub SNO (10.131.71.72)", "Agent K8s API (10.131.73.21)", "443/TCP", "HTTPS", "Hub → Agent", "If K8s API uses port 443 instead of 6443"],
          ["5", "Browser (User)", "Hub Route (10.131.71.72)", "443/TCP", "HTTPS", "External → Hub", "Dashboard access via OpenShift Route"],
          ["6", "Hub SNO (10.131.71.72)", "External LLM API", "443/TCP", "HTTPS", "Hub → Internet", "Azure OpenAI / LLM for AI chat features"],
        ],
        [5, 17, 17, 10, 8, 13, 30]
      ),

      heading("5.3 Internal Cluster Flows (No Firewall Change Needed)", 2),
      dataTable(
        ["#", "Source", "Destination", "Port", "Protocol", "Purpose"],
        [
          ["A", "MCP Server Pod", "PostgreSQL Pod", "5432/TCP", "TCP", "Database (within SNO namespace)"],
          ["B", "Agent Pod", "Local K8s API", "6443/TCP", "HTTPS", "Agent scans own cluster (within agent cluster)"],
          ["C", "OCP Router", "MCP Server Pod", "3000/TCP", "HTTP", "Route → pod (within SNO)"],
        ],
        [5, 18, 18, 10, 10, 39]
      ),

      // ═══════════════════════════════════════════════════════════════
      // 6. FIREWALL RULES MATRIX
      // ═══════════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("6. Firewall Rules Matrix", 1),
      para("The following firewall rules are required between the two cluster networks. Apply these rules bidirectionally at the network boundary.", { after: 120 }),

      heading("6.1 Rules to ALLOW (Mandatory)", 2),
      dataTable(
        ["Rule", "Source IP/CIDR", "Dest IP/CIDR", "Dest Port", "Protocol", "Action", "Description"],
        [
          ["FW-01", "10.131.73.21/32\n10.131.73.22/32\n10.131.73.23/32", "10.131.71.72/32", "3000", "TCP", "ALLOW", "Agent nodes → Hub MCP Server (reports)"],
          ["FW-02", "10.131.71.72/32", "10.131.73.21/32", "6443", "TCP", "ALLOW", "Hub → Agent K8s API (health probes)"],
          ["FW-03", "10.131.73.21/32\n10.131.73.22/32\n10.131.73.23/32", "10.131.71.72/32", "443", "TCP", "ALLOW", "Agent → Hub via OpenShift Route (HTTPS)"],
          ["FW-04", "10.131.71.72/32", "10.131.73.21/32", "443", "TCP", "ALLOW", "Hub → Agent K8s API (if on port 443)"],
        ],
        [7, 17, 15, 8, 8, 8, 37]
      ),

      heading("6.2 Recommended CIDR-Based Rules (Alternative)", 2),
      para("If individual IP rules are not practical, use CIDR ranges:", { after: 60 }),
      dataTable(
        ["Rule", "Source CIDR", "Dest CIDR", "Dest Port", "Protocol", "Action"],
        [
          ["FW-ALT-01", "10.131.73.0/24", "10.131.71.0/24", "3000, 443", "TCP", "ALLOW"],
          ["FW-ALT-02", "10.131.71.0/24", "10.131.73.0/24", "6443, 443", "TCP", "ALLOW"],
        ],
        [12, 18, 18, 14, 12, 12]
      ),

      // ═══════════════════════════════════════════════════════════════
      // 7. DNS REQUIREMENTS
      // ═══════════════════════════════════════════════════════════════
      heading("7. DNS Requirements", 1),
      para("The Agent must resolve the Hub's hostname. Configure DNS or /etc/hosts as follows:", { after: 120 }),
      dataTable(
        ["Record Type", "Hostname", "Resolves To", "Required By"],
        [
          ["A / CNAME", "mcp-hub.apps.<sno-cluster-domain>", "10.131.71.72 (or Route VIP)", "Agent cluster (outbound to Hub)"],
          ["A", "api.<agent-cluster-domain>", "10.131.73.21", "Hub (for remote K8s API access)"],
          ["A", "*.apps.<agent-cluster-domain>", "10.131.73.21 or LB VIP", "Hub (optional, for agent Route access)"],
        ],
        [12, 30, 28, 30]
      ),
      para("Note: If the Hub's OpenShift Route uses a wildcard certificate, the Agent's HUB_SERVER_URL should use the Route hostname (not the IP). If using IP-based connectivity, set HUB_SERVER_URL=http://10.131.71.72:3000 in the agent deployment.", { after: 120 }),

      // ═══════════════════════════════════════════════════════════════
      // 8. TLS / CERTIFICATE REQUIREMENTS
      // ═══════════════════════════════════════════════════════════════
      heading("8. TLS / Certificate Requirements", 1),
      dataTable(
        ["Connection", "TLS Required", "Certificate Source", "Notes"],
        [
          ["Agent → Hub (:3000)", "Optional (recommended)", "OpenShift Route cert (edge termination)", "Agent can use HTTP if on trusted network; HTTPS via Route preferred"],
          ["Hub → K8s API (:6443)", "Yes (mandatory)", "Agent cluster's CA cert", "Hub uses service account token + CA for auth"],
          ["Browser → Hub Route", "Yes", "OpenShift ingress certificate", "Standard HTTPS access"],
          ["Agent → Local K8s API", "Yes", "Service account CA (auto-mounted)", "Agent auto-detects /var/run/secrets/..."],
        ],
        [20, 15, 25, 40]
      ),

      // ═══════════════════════════════════════════════════════════════
      // 9. AGENT COMMUNICATION PROTOCOL
      // ═══════════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("9. Agent Communication Protocol", 1),

      heading("9.1 Registration (One-Time)", 2),
      para("When the agent pod starts, it sends a single registration request to the Hub:", { after: 80 }),
      ...monoBlock([
        "POST /api/agent/register HTTP/1.1",
        "Host: <HUB_SERVER_URL>",
        "Content-Type: application/json",
        "",
        "{",
        '  "clusterName": "production-3node",',
        '  "platform": "openshift",',
        '  "agentVersion": "1.0.0",',
        '  "capabilities": ["scan", "events", "metrics", "openshift"]',
        "}",
      ]),

      heading("9.2 Periodic Reports (Every 60s)", 2),
      para("The agent scans the local Kubernetes API and pushes the report to the Hub:", { after: 80 }),
      ...monoBlock([
        "POST /api/agent/report HTTP/1.1",
        "Host: <HUB_SERVER_URL>",
        "Content-Type: application/json",
        "Timeout: 15 seconds",
        "",
        "{",
        '  "clusterName": "production-3node",',
        '  "report": {',
        '    "timestamp": "2026-05-28T10:30:00Z",',
        '    "nodes": { "total": 3, "ready": 3, "items": [...] },',
        '    "pods": { "total": 45, "running": 42, "failed": 0 },',
        '    "deployments": { "total": 12, "available": 12 },',
        '    "events": { "warnings": 2, "recent": [...] },',
        '    "namespaces": 15,',
        '    "openshiftVersion": "4.16.x"',
        "  }",
        "}",
      ]),

      heading("9.3 Health Probes (Hub → Agent Cluster)", 2),
      para("The Hub probes each registered cluster's Kubernetes API every 60 seconds:", { after: 80 }),
      ...monoBlock([
        "GET /api/v1/namespaces?limit=1 HTTP/1.1",
        "Host: api.<agent-cluster>:6443",
        "Authorization: Bearer <service-account-token>",
        "Timeout: 8 seconds",
      ]),

      heading("9.4 Connection Failure Handling", 2),
      bulletPara("If the agent cannot reach the Hub, it retries on the next scan interval (60s). No data is lost — the next report contains the full current state."),
      bulletPara("If the Hub cannot reach the agent's K8s API, the cluster status changes to 'unreachable' after 5 minutes. Dashboard shows a warning."),
      bulletPara("Agent registration is automatically re-sent if the Hub restarts or the connection is lost."),
      bulletPara("No persistent connection is maintained — all communication is stateless HTTP request-response."),

      // ═══════════════════════════════════════════════════════════════
      // 10. DEPLOYMENT TOPOLOGY
      // ═══════════════════════════════════════════════════════════════
      heading("10. Deployment Topology", 1),

      heading("10.1 Hub Deployment (SNO — 10.131.71.72)", 2),
      dataTable(
        ["Component", "Namespace", "Type", "Replicas", "Port", "Notes"],
        [
          ["MCP Server", "openshift-mcp", "Deployment", "1", "3000", "Main application pod"],
          ["PostgreSQL", "openshift-mcp", "StatefulSet", "1", "5432", "Optional — for chat history, audit log"],
          ["Route", "openshift-mcp", "Route", "—", "443→3000", "TLS edge, 600s timeout for SSE"],
          ["Service", "openshift-mcp", "Service", "—", "3000", "ClusterIP service"],
        ],
        [15, 15, 12, 10, 10, 38]
      ),

      heading("10.2 Agent Deployment (3-Node — 10.131.73.x)", 2),
      dataTable(
        ["Component", "Namespace", "Type", "Replicas", "Port", "Notes"],
        [
          ["MCP Agent", "openshift-mcp-agent", "Deployment", "1", "8080", "Lightweight scanner + reporter"],
          ["ServiceAccount", "openshift-mcp-agent", "ServiceAccount", "—", "—", "Cluster-reader RBAC for scanning"],
          ["ClusterRoleBinding", "—", "CRB", "—", "—", "Binds SA to cluster-reader role"],
        ],
        [15, 18, 12, 10, 8, 37]
      ),

      heading("10.3 Agent Environment Variables", 2),
      dataTable(
        ["Variable", "Value", "Description"],
        [
          ["HUB_SERVER_URL", "http://10.131.71.72:3000  (or Route URL)", "Hub API endpoint the agent reports to"],
          ["CLUSTER_NAME", "production-3node", "Unique name for this cluster in the Hub"],
          ["CLUSTER_PLATFORM", "openshift", "Platform type (openshift, k8s, eks, etc.)"],
          ["SCAN_INTERVAL", "60", "Seconds between cluster scans"],
          ["LOG_LEVEL", "info", "Agent log verbosity"],
          ["PORT", "8080", "Agent health endpoint port"],
        ],
        [20, 35, 45]
      ),

      // ═══════════════════════════════════════════════════════════════
      // 11. BANDWIDTH & PERFORMANCE
      // ═══════════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("11. Bandwidth & Performance Requirements", 1),
      dataTable(
        ["Metric", "Value", "Notes"],
        [
          ["Agent report payload size", "5-50 KB per report", "Depends on cluster size (pods, events)"],
          ["Report frequency", "Every 60 seconds", "Configurable via SCAN_INTERVAL"],
          ["Bandwidth (Agent → Hub)", "~1-5 KB/s sustained", "Minimal — small JSON payloads"],
          ["Health probe size", "< 1 KB per probe", "Simple GET request + response"],
          ["Connection duration", "< 1 second per request", "Stateless HTTP, no persistent connections"],
          ["Max concurrent connections", "1 per agent cluster", "Sequential request-response"],
          ["Network latency tolerance", "< 15 seconds RTT", "Agent report timeout is 15s"],
        ],
        [25, 22, 53]
      ),

      // ═══════════════════════════════════════════════════════════════
      // 12. SECURITY CONSIDERATIONS
      // ═══════════════════════════════════════════════════════════════
      heading("12. Security Considerations", 1),
      bulletPara("All agent-to-hub communication can be encrypted via HTTPS (OpenShift Route with TLS edge termination)."),
      bulletPara("The agent uses a Kubernetes ServiceAccount with cluster-reader permissions only — it cannot modify resources on the remote cluster."),
      bulletPara("Hub stores cluster tokens in-memory and optionally in PostgreSQL. Tokens are never exposed in API responses."),
      bulletPara("Agent pods run as non-root (UID 1001) with read-only filesystem."),
      bulletPara("No inbound ports need to be opened on the agent cluster for agent communication — the agent initiates all connections outbound."),
      bulletPara("Hub health probes to the agent cluster's K8s API use Bearer token authentication with minimal permissions."),
      bulletPara("No VPN, service mesh, or special network infrastructure is required."),

      // ═══════════════════════════════════════════════════════════════
      // 13. VALIDATION & TESTING
      // ═══════════════════════════════════════════════════════════════
      heading("13. Validation & Testing Plan", 1),
      para("After firewall rules are applied, validate connectivity with the following tests:", { after: 120 }),
      dataTable(
        ["#", "Test", "Command (from source)", "Expected Result"],
        [
          ["1", "Agent → Hub reachability", "curl -v http://10.131.71.72:3000/healthz  (from any agent node)", "HTTP 200 OK"],
          ["2", "Agent → Hub Route (HTTPS)", "curl -kv https://mcp-hub.apps.<domain>/healthz  (from agent node)", "HTTP 200 OK"],
          ["3", "Hub → Agent K8s API", "curl -k https://10.131.73.21:6443/version  (from SNO node)", "JSON with Kubernetes version"],
          ["4", "DNS resolution", "nslookup mcp-hub.apps.<domain>  (from agent node)", "Resolves to 10.131.71.72"],
          ["5", "TCP port scan", "nc -zv 10.131.71.72 3000  (from agent node)", "Connection succeeded"],
          ["6", "TCP port scan", "nc -zv 10.131.73.21 6443  (from SNO node)", "Connection succeeded"],
          ["7", "Agent registration", "Deploy agent pod → check Hub dashboard", "Cluster appears in Hub UI"],
        ],
        [5, 22, 40, 33]
      ),

      // ═══════════════════════════════════════════════════════════════
      // 14. APPENDIX A — PORT REFERENCE
      // ═══════════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("14. Appendix A — Complete Port Reference", 1),
      dataTable(
        ["Port", "Protocol", "Service", "Used By", "Notes"],
        [
          ["3000/TCP", "HTTP", "MCP Server API", "Hub pod", "Main application port"],
          ["8080/TCP", "HTTP", "Agent health/status", "Agent pod", "Liveness + readiness probes"],
          ["6443/TCP", "HTTPS", "Kubernetes API", "Both clusters", "Control plane API server"],
          ["443/TCP", "HTTPS", "OpenShift Route", "Hub (external)", "TLS edge termination for dashboard"],
          ["5432/TCP", "TCP", "PostgreSQL", "Hub pod (internal)", "Optional database, not exposed externally"],
          ["22/TCP", "SSH", "Node access", "Both clusters", "Standard SSH — no change needed"],
        ],
        [10, 10, 18, 18, 44]
      ),

      // ═══════════════════════════════════════════════════════════════
      // 15. APPENDIX B — DIAGRAM (TEXT)
      // ═══════════════════════════════════════════════════════════════
      heading("15. Appendix B — Simplified Data Flow", 1),
      ...monoBlock([
        "",
        "   ┌────────────────────────┐          ┌─────────────────────────────┐",
        "   │  SNO HUB               │          │  3-NODE AGENT CLUSTER       │",
        "   │  10.131.71.72          │          │  10.131.73.21/22/23         │",
        "   │                        │          │                             │",
        "   │  ┌──────────────────┐  │  :3000   │  ┌───────────────────────┐ │",
        "   │  │  MCP Server      │◄─┼──────────┼──┤  Agent Pod            │ │",
        "   │  │  (Hub)           │  │  HTTP    │  │  - Scanner            │ │",
        "   │  │                  │  │  POST    │  │  - Reporter           │ │",
        "   │  │  /api/agent/*    │  │          │  │  Interval: 60s        │ │",
        "   │  └────────┬─────────┘  │          │  └───────────────────────┘ │",
        "   │           │            │  :6443   │  ┌───────────────────────┐ │",
        "   │           └────────────┼──────────┼──►  Kubernetes API       │ │",
        "   │            HTTPS GET   │          │  │  (Health probes)      │ │",
        "   │                        │          │  └───────────────────────┘ │",
        "   └────────────────────────┘          └─────────────────────────────┘",
        "",
        "   FLOWS:",
        "   ══════",
        "   [1] Agent Pod → Hub :3000       POST /api/agent/register (once)",
        "   [2] Agent Pod → Hub :3000       POST /api/agent/report  (every 60s)",
        "   [3] Hub → Agent K8s API :6443   GET /api/v1/namespaces  (health probe)",
        "",
      ]),

      new Paragraph({ spacing: { before: 400 } }),
      para("— End of Document —", { align: AlignmentType.CENTER, italic: true }),
      para("Generated by TCS KubeNexus AI Platform", { align: AlignmentType.CENTER, size: 18 }),
    ],
  }],
});

const buffer = await Packer.toBuffer(doc);
const outPath = "docs/TCS-KubeNexus-AI-Multi-Cluster-Network-Architecture.docx";
await writeFile(outPath, buffer);
console.log("Created: " + outPath + " (" + buffer.length + " bytes)");
