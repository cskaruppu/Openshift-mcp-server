import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, WidthType, BorderStyle, AlignmentType, PageBreak, VerticalAlign, ShadingType } from "docx";
import { writeFile } from "node:fs/promises";

// ── Color Palette ──
const C = {
  navyDark: "0F1B2D",
  navy: "1e3a5f",
  blue: "2563eb",
  blueBg: "DBEAFE",
  blueLight: "EFF6FF",
  green: "15803d",
  greenBg: "D1FAE5",
  greenLight: "ECFDF5",
  orange: "C2410C",
  orangeBg: "FED7AA",
  orangeLight: "FFF7ED",
  purple: "7C3AED",
  purpleBg: "DDD6FE",
  purpleLight: "F5F3FF",
  red: "DC2626",
  redBg: "FEE2E2",
  pink: "DB2777",
  pinkBg: "FCE7F3",
  teal: "0D9488",
  tealBg: "CCFBF1",
  gray: "6B7280",
  grayLight: "F9FAFB",
  grayBorder: "E5E7EB",
  white: "FFFFFF",
  black: "111827",
};

const noBorder = { style: BorderStyle.NONE, size: 0, color: C.white };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };
const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: C.grayBorder };
const thinBorders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

function heading(text, level) {
  const map = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 };
  return new Paragraph({ text, heading: map[level] || HeadingLevel.HEADING_1, spacing: { before: 300, after: 100 } });
}

function para(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, bold: opts.bold, italics: opts.italic, size: opts.size || 22, font: opts.font || "Calibri", color: opts.color })],
    spacing: { after: opts.after || 80, before: opts.before || 0 },
    alignment: opts.align,
  });
}

function richPara(runs, opts = {}) {
  return new Paragraph({
    children: runs.map(r => new TextRun({ text: r.text, bold: r.bold, italics: r.italic, size: r.size || 22, font: r.font || "Calibri", color: r.color })),
    spacing: { after: opts.after || 80 },
    alignment: opts.align,
  });
}

function bulletPara(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, bold: opts.bold, size: opts.size || 22, color: opts.color })],
    bullet: { level: opts.level || 0 },
    spacing: { after: 40 },
  });
}

function styledCell(content, opts = {}) {
  const children = typeof content === "string"
    ? [new Paragraph({
        children: [new TextRun({ text: content, bold: opts.bold, size: opts.size || 20, color: opts.color || C.black, font: opts.font || "Calibri" })],
        alignment: opts.align || AlignmentType.LEFT,
        spacing: { after: 0, before: 0 },
      })]
    : Array.isArray(content) ? content : [content];
  return new TableCell({
    children,
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    borders: opts.borders || thinBorders,
    shading: opts.shading ? { fill: opts.shading, type: ShadingType.CLEAR } : undefined,
    verticalAlign: opts.vAlign || VerticalAlign.CENTER,
    columnSpan: opts.colSpan,
    rowSpan: opts.rowSpan,
    margins: opts.margins || { top: 60, bottom: 60, left: 100, right: 100 },
  });
}

function headerCell(text, opts = {}) {
  return styledCell(text, { bold: true, color: C.white, shading: opts.shading || C.navy, align: opts.align || AlignmentType.LEFT, width: opts.width, size: opts.size || 20, colSpan: opts.colSpan });
}

function dataTable(headers, dataRows, colWidths, opts = {}) {
  const w = colWidths || headers.map(() => Math.floor(100 / headers.length));
  const headerColor = opts.headerColor || C.navy;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: headers.map((h, i) => headerCell(h, { width: w[i], shading: headerColor })) }),
      ...dataRows.map((row, ri) => new TableRow({
        children: row.map((c, i) => styledCell(c, { width: w[i], shading: ri % 2 === 1 ? C.grayLight : C.white })),
      })),
    ],
  });
}

function kvTable(rows, opts = {}) {
  const color = opts.color || C.navy;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [headerCell("Parameter", { width: 35, shading: color }), headerCell("Value", { width: 65, shading: color })] }),
      ...rows.map(([k, v], i) => new TableRow({
        children: [
          styledCell(k, { width: 35, bold: true, shading: i % 2 === 1 ? C.grayLight : C.white }),
          styledCell(v, { width: 65, shading: i % 2 === 1 ? C.grayLight : C.white }),
        ],
      })),
    ],
  });
}

// Colored architecture box — a single-cell table with colored background
function archBox(title, subtitle, items, opts = {}) {
  const bg = opts.bg || C.blueBg;
  const borderColor = opts.border || C.blue;
  const titleColor = opts.titleColor || C.navy;
  const boxBorder = { style: BorderStyle.SINGLE, size: 3, color: borderColor };
  const boxBorders = { top: boxBorder, bottom: boxBorder, left: boxBorder, right: boxBorder };
  const children = [
    new Paragraph({
      children: [new TextRun({ text: title, bold: true, size: 24, color: titleColor, font: "Calibri" })],
      spacing: { after: 20 },
    }),
  ];
  if (subtitle) {
    children.push(new Paragraph({
      children: [new TextRun({ text: subtitle, size: 18, color: C.gray, font: "Calibri", italics: true })],
      spacing: { after: 40 },
    }));
  }
  for (const item of items) {
    children.push(new Paragraph({
      children: [
        new TextRun({ text: "  " + (item.icon || "●") + "  ", size: 18, color: borderColor }),
        new TextRun({ text: item.label, bold: item.bold, size: 18, color: C.black, font: "Calibri" }),
        ...(item.detail ? [new TextRun({ text: "  " + item.detail, size: 16, color: C.gray, font: "Calibri" })] : []),
      ],
      spacing: { after: 20 },
    }));
  }
  return new Table({
    width: { size: opts.width || 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: [new TableCell({ children, shading: { fill: bg, type: ShadingType.CLEAR }, borders: boxBorders, margins: { top: 120, bottom: 120, left: 160, right: 160 } })] })],
  });
}

// Flow arrow row — shows direction between two entities
function flowArrow(from, direction, to, port, protocol, purpose, opts = {}) {
  const arrowColor = opts.color || C.blue;
  const arrow = direction === "right" ? "────▶" : "◀────";
  const dashed = opts.dashed ? " (dashed)" : "";
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        styledCell(from, { width: 22, bold: true, shading: opts.fromBg || C.blueBg, size: 18, align: AlignmentType.CENTER }),
        styledCell([new Paragraph({
          children: [
            new TextRun({ text: arrow, size: 24, color: arrowColor, font: "Calibri", bold: true }),
            new TextRun({ text: "\n" + port + " " + protocol, size: 16, color: C.gray, font: "Calibri" }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { after: 0 },
        })], { width: 20, align: AlignmentType.CENTER, shading: C.white }),
        styledCell(to, { width: 22, bold: true, shading: opts.toBg || C.greenBg, size: 18, align: AlignmentType.CENTER }),
        styledCell(purpose, { width: 36, size: 18, shading: C.white }),
      ],
    })],
  });
}

const doc = new Document({
  styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
  sections: [{
    properties: { page: { margin: { top: 1200, bottom: 1200, left: 1200, right: 1200 } } },
    children: [
      // ═══════════════════════════════════════════════════════════
      // COVER PAGE — colored banner
      // ═══════════════════════════════════════════════════════════
      new Paragraph({ spacing: { before: 1200 } }),
      new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: [
        new TableCell({
          children: [
            new Paragraph({ spacing: { before: 400 } }),
            new Paragraph({ children: [new TextRun({ text: "TCS KubeNexus AI", bold: true, size: 56, color: C.white, font: "Calibri" })], alignment: AlignmentType.CENTER, spacing: { after: 80 } }),
            new Paragraph({ children: [new TextRun({ text: "Multi-Cluster Network Architecture", size: 36, color: "93C5FD", font: "Calibri" })], alignment: AlignmentType.CENTER, spacing: { after: 120 } }),
            new Paragraph({ children: [new TextRun({ text: "──────────────────────────────", size: 20, color: "3B82F6" })], alignment: AlignmentType.CENTER, spacing: { after: 120 } }),
            new Paragraph({ children: [new TextRun({ text: "SNO Hub + 3-Node Agent Cluster Connectivity", size: 28, color: C.white, font: "Calibri", italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 200 } }),
            new Paragraph({ children: [new TextRun({ text: "Prepared for: Network Engineering Team", size: 22, color: "93C5FD" })], alignment: AlignmentType.CENTER, spacing: { after: 40 } }),
            new Paragraph({ children: [new TextRun({ text: "Date: " + new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }), size: 22, color: "93C5FD" })], alignment: AlignmentType.CENTER, spacing: { after: 40 } }),
            new Paragraph({ children: [new TextRun({ text: "Classification: Internal — Infrastructure", size: 20, color: "60A5FA", italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 400 } }),
          ],
          shading: { fill: C.navyDark, type: ShadingType.CLEAR },
          borders: noBorders,
          margins: { top: 200, bottom: 200, left: 300, right: 300 },
        }),
      ]})] }),

      // ═══════════════════════════════════════════════════════════
      // TOC
      // ═══════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("Table of Contents", 1),
      ...[
        "1. Executive Summary", "2. Current Environment", "3. Architecture Overview",
        "4. Architecture Diagram", "5. Network Connectivity Requirements",
        "6. Firewall Rules Matrix", "7. DNS Requirements", "8. TLS / Certificate Requirements",
        "9. Agent Communication Protocol", "10. Deployment Topology",
        "11. Bandwidth & Performance", "12. Security Considerations",
        "13. Validation & Testing Plan",
      ].map(t => para(t, { after: 40 })),

      // ═══════════════════════════════════════════════════════════
      // 1. EXECUTIVE SUMMARY
      // ═══════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("1. Executive Summary", 1),
      para("This document outlines the network architecture and connectivity requirements for extending the TCS KubeNexus AI platform from a Single Node OpenShift (SNO) deployment to a multi-cluster configuration.", { after: 120 }),
      // Key facts callout box
      new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: [
        new TableCell({
          children: [
            new Paragraph({ children: [new TextRun({ text: "KEY FACTS", bold: true, size: 22, color: C.blue })], spacing: { after: 60 } }),
            new Paragraph({ children: [
              new TextRun({ text: "■ Hub Cluster: ", bold: true, size: 20, color: C.black }),
              new TextRun({ text: "SNO at 10.131.71.72 — runs TCS KubeNexus AI MCP Server", size: 20, color: C.gray }),
            ], spacing: { after: 40 } }),
            new Paragraph({ children: [
              new TextRun({ text: "■ Agent Cluster: ", bold: true, size: 20, color: C.black }),
              new TextRun({ text: "3-node at 10.131.73.21-23 — runs lightweight monitoring agent", size: 20, color: C.gray }),
            ], spacing: { after: 40 } }),
            new Paragraph({ children: [
              new TextRun({ text: "■ Key Ports: ", bold: true, size: 20, color: C.black }),
              new TextRun({ text: "TCP 3000 (Hub API), TCP 6443 (K8s API), TCP 443 (HTTPS Route)", size: 20, color: C.gray }),
            ], spacing: { after: 40 } }),
            new Paragraph({ children: [
              new TextRun({ text: "■ Protocol: ", bold: true, size: 20, color: C.black }),
              new TextRun({ text: "Standard HTTP/HTTPS over TCP — no VPN, no message queues, no special infrastructure", size: 20, color: C.gray }),
            ], spacing: { after: 20 } }),
          ],
          shading: { fill: C.blueLight, type: ShadingType.CLEAR },
          borders: { top: { style: BorderStyle.SINGLE, size: 3, color: C.blue }, bottom: thinBorder, left: { style: BorderStyle.SINGLE, size: 3, color: C.blue }, right: thinBorder },
          margins: { top: 120, bottom: 120, left: 160, right: 160 },
        }),
      ]})] }),

      // ═══════════════════════════════════════════════════════════
      // 2. CURRENT ENVIRONMENT
      // ═══════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("2. Current Environment", 1),

      heading("2.1 SNO Hub Cluster (Existing)", 2),
      kvTable([
        ["Cluster Type", "Single Node OpenShift (SNO)"],
        ["Node IP", "10.131.71.72"],
        ["Role", "MCP Hub — central management plane"],
        ["Namespace", "openshift-mcp"],
        ["MCP Server Pod Port", "3000 (MCP_SERVER_PORT)"],
        ["Exposed via", "OpenShift Route (HTTPS, TLS edge termination)"],
        ["Components", "MCP Server, Dashboard, AI Chat, Multi-Cluster Hub, PostgreSQL"],
      ], { color: C.blue }),
      para(""),

      heading("2.2 3-Node Agent Cluster (New)", 2),
      kvTable([
        ["Cluster Type", "3-Node OpenShift Cluster (HA)"],
        ["Control Plane / Master", "10.131.73.21"],
        ["Worker Node 1", "10.131.73.22"],
        ["Worker Node 2", "10.131.73.23"],
        ["Role", "Managed Agent — reports cluster state to Hub"],
        ["Agent Namespace", "openshift-mcp-agent"],
        ["Agent Pod Port", "8080 (health/status endpoints)"],
        ["Kubernetes API", "https://api.<cluster>:6443"],
      ], { color: C.green }),

      // ═══════════════════════════════════════════════════════════
      // 3. ARCHITECTURE OVERVIEW
      // ═══════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("3. Architecture Overview", 1),
      para("The multi-cluster architecture follows a Hub-and-Spoke model. Communication is agent-initiated (outbound). The Hub never initiates connections to the agent pod.", { after: 120 }),

      bulletPara("Hub (SNO): Runs the TCS KubeNexus AI MCP Server. Hosts the unified dashboard, AI chat, and all management tools."),
      bulletPara("Agent (3-Node): Runs a lightweight agent pod that scans the local cluster every 60 seconds and pushes reports to the Hub via HTTP POST."),
      bulletPara("All communication uses standard HTTP/HTTPS over TCP. No VPNs, message queues, or special protocols required."),

      // ═══════════════════════════════════════════════════════════
      // 4. ARCHITECTURE DIAGRAM — colored boxes
      // ═══════════════════════════════════════════════════════════
      heading("4. Architecture Diagram", 1),
      para("The following diagram shows the logical architecture with all components and communication paths.", { after: 120 }),

      // ── Hub Cluster Box ──
      archBox(
        "☁  SNO HUB CLUSTER",
        "10.131.71.72 — Namespace: openshift-mcp",
        [
          { icon: "▸", label: "MCP Server (Hub)", detail: "Port 3000 — Core application", bold: true },
          { icon: "▸", label: "Dashboard & AI Chat", detail: "Unified management UI" },
          { icon: "▸", label: "Multi-Cluster Hub", detail: "Agent registry & cluster aggregation" },
          { icon: "▸", label: "Deploy Orchestrator", detail: "Document-driven deployment engine" },
          { icon: "▸", label: "PostgreSQL", detail: "Port 5432 — Chat history, audit log (optional)" },
          { icon: "▸", label: "OpenShift Route", detail: "HTTPS :443 → :3000 (TLS edge, 600s timeout)" },
        ],
        { bg: C.blueBg, border: C.blue, titleColor: C.navy }
      ),
      para(""),

      // ── Communication Flows ──
      new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: [
        new TableCell({
          children: [
            new Paragraph({ children: [new TextRun({ text: "COMMUNICATION FLOWS", bold: true, size: 22, color: C.white })], alignment: AlignmentType.CENTER, spacing: { after: 0 } }),
          ],
          shading: { fill: C.navyDark, type: ShadingType.CLEAR },
          borders: noBorders,
          margins: { top: 80, bottom: 80, left: 100, right: 100 },
        }),
      ]})] }),
      para(""),

      // Flow 1: Agent → Hub
      flowArrow("Agent Pod", "right", "MCP Hub", ":3000", "HTTP POST", "Agent registration (once) + periodic reports (every 60s)", { color: C.blue, fromBg: C.greenBg, toBg: C.blueBg }),
      para(""),
      // Flow 2: Hub → K8s API
      flowArrow("MCP Hub", "right", "K8s API", ":6443", "HTTPS GET", "On-demand health probes + remote cluster queries (every 60s)", { color: C.orange, fromBg: C.blueBg, toBg: C.orangeBg }),
      para(""),
      // Flow 3: Browser → Hub
      flowArrow("Browser", "right", "OCP Route", ":443", "HTTPS", "Dashboard access via OpenShift Route (TLS edge termination)", { color: C.purple, fromBg: C.pinkBg, toBg: C.blueBg }),
      para(""),

      // ── Agent Cluster Box ──
      archBox(
        "☁  3-NODE AGENT CLUSTER",
        "10.131.73.21 / .22 / .23 — Namespace: openshift-mcp-agent",
        [
          { icon: "▸", label: "MCP Agent Pod", detail: "Port 8080 — Scanner + Reporter", bold: true },
          { icon: "▸", label: "Scanner", detail: "Polls local K8s API every 60s (nodes, pods, deployments, events)" },
          { icon: "▸", label: "Reporter", detail: "Pushes JSON report to Hub via HTTP POST" },
          { icon: "▸", label: "Health Endpoints", detail: "/healthz, /readyz, /status, /scan" },
          { icon: "▸", label: "Kubernetes API", detail: "Port 6443 — Master node 10.131.73.21" },
          { icon: "▸", label: "Nodes", detail: "Master: 10.131.73.21 | Worker1: .22 | Worker2: .23" },
        ],
        { bg: C.greenBg, border: C.green, titleColor: C.green }
      ),

      // ═══════════════════════════════════════════════════════════
      // 5. NETWORK CONNECTIVITY REQUIREMENTS
      // ═══════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("5. Network Connectivity Requirements", 1),
      para("All flows use TCP protocol. The following table lists all required network paths between the two clusters.", { after: 120 }),

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
      para(""),
      heading("5.2 Optional Flows", 2),
      dataTable(
        ["#", "Source", "Destination", "Port", "Protocol", "Direction", "Purpose"],
        [
          ["4", "Agent nodes (10.131.73.x)", "Hub Route (10.131.71.72)", "443/TCP", "HTTPS", "Agent → Hub", "If agent uses HTTPS Route URL"],
          ["5", "Browser (User)", "Hub Route (10.131.71.72)", "443/TCP", "HTTPS", "External → Hub", "Dashboard access"],
          ["6", "Hub (10.131.71.72)", "External LLM API", "443/TCP", "HTTPS", "Hub → Internet", "Azure OpenAI for AI chat features"],
        ],
        [5, 17, 17, 10, 8, 13, 30]
      ),

      // ═══════════════════════════════════════════════════════════
      // 6. FIREWALL RULES
      // ═══════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("6. Firewall Rules Matrix", 1),
      para("Apply the following firewall rules at the network boundary between the two cluster networks.", { after: 120 }),

      heading("6.1 Required Rules", 2),
      dataTable(
        ["Rule ID", "Source IP/CIDR", "Destination IP", "Port", "Protocol", "Action", "Description"],
        [
          ["FW-01", "10.131.73.21\n10.131.73.22\n10.131.73.23", "10.131.71.72", "3000", "TCP", "ALLOW", "Agent nodes → Hub MCP Server"],
          ["FW-02", "10.131.71.72", "10.131.73.21", "6443", "TCP", "ALLOW", "Hub → Agent K8s API server"],
          ["FW-03", "10.131.73.21\n10.131.73.22\n10.131.73.23", "10.131.71.72", "443", "TCP", "ALLOW", "Agent → Hub via OpenShift Route"],
          ["FW-04", "10.131.71.72", "10.131.73.21", "443", "TCP", "ALLOW", "Hub → Agent K8s API (if port 443)"],
        ],
        [8, 16, 14, 7, 8, 8, 39],
        { headerColor: C.red }
      ),
      para(""),
      heading("6.2 CIDR-Based Alternative", 2),
      dataTable(
        ["Rule ID", "Source CIDR", "Destination CIDR", "Port(s)", "Protocol", "Action"],
        [
          ["FW-ALT-01", "10.131.73.0/24", "10.131.71.0/24", "3000, 443", "TCP", "ALLOW"],
          ["FW-ALT-02", "10.131.71.0/24", "10.131.73.0/24", "6443, 443", "TCP", "ALLOW"],
        ],
        [12, 18, 18, 14, 12, 12],
        { headerColor: C.orange }
      ),

      // ═══════════════════════════════════════════════════════════
      // 7. DNS
      // ═══════════════════════════════════════════════════════════
      heading("7. DNS Requirements", 1),
      dataTable(
        ["Record Type", "Hostname", "Resolves To", "Required By"],
        [
          ["A / CNAME", "mcp-hub.apps.<sno-domain>", "10.131.71.72 (or Route VIP)", "Agent cluster"],
          ["A", "api.<agent-domain>", "10.131.73.21", "Hub (remote K8s API)"],
          ["A", "*.apps.<agent-domain>", "10.131.73.21 or LB VIP", "Hub (optional)"],
        ],
        [12, 28, 28, 32]
      ),
      para("Note: If using IP-based connectivity, set HUB_SERVER_URL=http://10.131.71.72:3000 in the agent deployment.", { italic: true, color: C.gray, after: 120 }),

      // ═══════════════════════════════════════════════════════════
      // 8. TLS
      // ═══════════════════════════════════════════════════════════
      heading("8. TLS / Certificate Requirements", 1),
      dataTable(
        ["Connection", "TLS Required", "Certificate Source", "Notes"],
        [
          ["Agent → Hub (:3000)", "Optional (recommended)", "OpenShift Route cert", "HTTP if on trusted network; HTTPS via Route preferred"],
          ["Hub → K8s API (:6443)", "Yes (mandatory)", "Agent cluster CA cert", "Hub uses service account token + CA"],
          ["Browser → Hub Route", "Yes", "OpenShift ingress cert", "Standard HTTPS dashboard access"],
          ["Agent → Local K8s API", "Yes", "Auto-mounted SA cert", "Agent auto-detects /var/run/secrets/..."],
        ],
        [22, 16, 22, 40],
        { headerColor: C.teal }
      ),

      // ═══════════════════════════════════════════════════════════
      // 9. AGENT PROTOCOL
      // ═══════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("9. Agent Communication Protocol", 1),

      heading("9.1 Registration (One-Time on Startup)", 2),
      // Styled code block
      new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: [
        new TableCell({
          children: [
            new Paragraph({ children: [new TextRun({ text: "POST /api/agent/register", bold: true, size: 20, color: C.blue, font: "Consolas" })], spacing: { after: 20 } }),
            new Paragraph({ children: [new TextRun({ text: 'Host: <HUB_SERVER_URL>', size: 18, color: C.gray, font: "Consolas" })], spacing: { after: 20 } }),
            new Paragraph({ children: [new TextRun({ text: 'Content-Type: application/json', size: 18, color: C.gray, font: "Consolas" })], spacing: { after: 40 } }),
            new Paragraph({ children: [new TextRun({ text: '{', size: 18, color: C.black, font: "Consolas" })], spacing: { after: 10 } }),
            new Paragraph({ children: [new TextRun({ text: '  "clusterName": "production-3node",', size: 18, color: C.black, font: "Consolas" })], spacing: { after: 10 } }),
            new Paragraph({ children: [new TextRun({ text: '  "platform": "openshift",', size: 18, color: C.black, font: "Consolas" })], spacing: { after: 10 } }),
            new Paragraph({ children: [new TextRun({ text: '  "agentVersion": "1.0.0",', size: 18, color: C.black, font: "Consolas" })], spacing: { after: 10 } }),
            new Paragraph({ children: [new TextRun({ text: '  "capabilities": ["scan","events","metrics","openshift"]', size: 18, color: C.black, font: "Consolas" })], spacing: { after: 10 } }),
            new Paragraph({ children: [new TextRun({ text: '}', size: 18, color: C.black, font: "Consolas" })], spacing: { after: 0 } }),
          ],
          shading: { fill: "F8FAFC", type: ShadingType.CLEAR },
          borders: { top: { style: BorderStyle.SINGLE, size: 1, color: C.grayBorder }, bottom: { style: BorderStyle.SINGLE, size: 1, color: C.grayBorder }, left: { style: BorderStyle.SINGLE, size: 4, color: C.blue }, right: { style: BorderStyle.SINGLE, size: 1, color: C.grayBorder } },
          margins: { top: 100, bottom: 100, left: 160, right: 160 },
        }),
      ]})] }),

      heading("9.2 Periodic Reports (Every 60 Seconds)", 2),
      new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: [
        new TableCell({
          children: [
            new Paragraph({ children: [new TextRun({ text: "POST /api/agent/report", bold: true, size: 20, color: C.green, font: "Consolas" })], spacing: { after: 20 } }),
            new Paragraph({ children: [new TextRun({ text: 'Timeout: 15 seconds', size: 18, color: C.gray, font: "Consolas" })], spacing: { after: 40 } }),
            new Paragraph({ children: [new TextRun({ text: '{ "clusterName": "production-3node",', size: 18, color: C.black, font: "Consolas" })], spacing: { after: 10 } }),
            new Paragraph({ children: [new TextRun({ text: '  "report": {', size: 18, color: C.black, font: "Consolas" })], spacing: { after: 10 } }),
            new Paragraph({ children: [new TextRun({ text: '    "nodes": { "total": 3, "ready": 3 },', size: 18, color: C.black, font: "Consolas" })], spacing: { after: 10 } }),
            new Paragraph({ children: [new TextRun({ text: '    "pods": { "total": 45, "running": 42 },', size: 18, color: C.black, font: "Consolas" })], spacing: { after: 10 } }),
            new Paragraph({ children: [new TextRun({ text: '    "deployments": { "total": 12, "available": 12 },', size: 18, color: C.black, font: "Consolas" })], spacing: { after: 10 } }),
            new Paragraph({ children: [new TextRun({ text: '    "events": { "warnings": 2, "recent": [...] }', size: 18, color: C.black, font: "Consolas" })], spacing: { after: 10 } }),
            new Paragraph({ children: [new TextRun({ text: '  } }', size: 18, color: C.black, font: "Consolas" })], spacing: { after: 0 } }),
          ],
          shading: { fill: "F8FAFC", type: ShadingType.CLEAR },
          borders: { top: { style: BorderStyle.SINGLE, size: 1, color: C.grayBorder }, bottom: { style: BorderStyle.SINGLE, size: 1, color: C.grayBorder }, left: { style: BorderStyle.SINGLE, size: 4, color: C.green }, right: { style: BorderStyle.SINGLE, size: 1, color: C.grayBorder } },
          margins: { top: 100, bottom: 100, left: 160, right: 160 },
        }),
      ]})] }),

      heading("9.3 Connection Failure Handling", 2),
      bulletPara("If the agent cannot reach the Hub, it retries on the next scan interval (60s). No data is lost."),
      bulletPara("If the Hub cannot reach the agent's K8s API, cluster status changes to 'unreachable' after 5 minutes."),
      bulletPara("Agent registration is automatically re-sent if the Hub restarts."),
      bulletPara("No persistent connection is maintained — all communication is stateless HTTP request-response."),

      // ═══════════════════════════════════════════════════════════
      // 10. DEPLOYMENT TOPOLOGY
      // ═══════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("10. Deployment Topology", 1),
      heading("10.1 Hub Deployment (SNO)", 2),
      dataTable(
        ["Component", "Namespace", "Type", "Replicas", "Port", "Notes"],
        [
          ["MCP Server", "openshift-mcp", "Deployment", "1", "3000", "Main application pod"],
          ["PostgreSQL", "openshift-mcp", "StatefulSet", "1", "5432", "Optional — chat history, audit"],
          ["Route", "openshift-mcp", "Route", "—", "443→3000", "TLS edge, 600s SSE timeout"],
          ["Service", "openshift-mcp", "Service", "—", "3000", "ClusterIP service"],
        ],
        [15, 16, 12, 9, 10, 38],
        { headerColor: C.blue }
      ),
      para(""),
      heading("10.2 Agent Deployment (3-Node)", 2),
      dataTable(
        ["Component", "Namespace", "Type", "Replicas", "Port", "Notes"],
        [
          ["MCP Agent", "openshift-mcp-agent", "Deployment", "1", "8080", "Scanner + reporter"],
          ["ServiceAccount", "openshift-mcp-agent", "SA", "—", "—", "Cluster-reader RBAC"],
          ["ClusterRoleBinding", "—", "CRB", "—", "—", "Binds SA to cluster-reader role"],
        ],
        [15, 18, 12, 9, 8, 38],
        { headerColor: C.green }
      ),
      para(""),
      heading("10.3 Agent Environment Variables", 2),
      dataTable(
        ["Variable", "Value", "Description"],
        [
          ["HUB_SERVER_URL", "http://10.131.71.72:3000", "Hub API endpoint the agent reports to"],
          ["CLUSTER_NAME", "production-3node", "Unique name for this cluster in the Hub"],
          ["CLUSTER_PLATFORM", "openshift", "Platform type"],
          ["SCAN_INTERVAL", "60", "Seconds between cluster scans"],
          ["LOG_LEVEL", "info", "Agent log verbosity"],
          ["PORT", "8080", "Agent health endpoint port"],
        ],
        [22, 30, 48],
        { headerColor: C.navy }
      ),

      // ═══════════════════════════════════════════════════════════
      // 11. BANDWIDTH
      // ═══════════════════════════════════════════════════════════
      heading("11. Bandwidth & Performance Requirements", 1),
      dataTable(
        ["Metric", "Value", "Notes"],
        [
          ["Report payload size", "5–50 KB per report", "Depends on cluster size (pods, events)"],
          ["Report frequency", "Every 60 seconds", "Configurable via SCAN_INTERVAL"],
          ["Bandwidth (sustained)", "~1–5 KB/s", "Minimal — small JSON payloads"],
          ["Health probe size", "< 1 KB per probe", "Simple GET request + response"],
          ["Connection duration", "< 1 second per request", "Stateless HTTP, no persistent connections"],
          ["Max concurrent connections", "1 per agent cluster", "Sequential request-response"],
          ["Network latency tolerance", "< 15 seconds RTT", "Agent report timeout is 15s"],
        ],
        [25, 22, 53],
        { headerColor: C.purple }
      ),

      // ═══════════════════════════════════════════════════════════
      // 12. SECURITY
      // ═══════════════════════════════════════════════════════════
      heading("12. Security Considerations", 1),
      bulletPara("All agent-to-hub communication can be encrypted via HTTPS (OpenShift Route TLS edge termination)."),
      bulletPara("Agent uses a Kubernetes ServiceAccount with cluster-reader permissions only — cannot modify resources."),
      bulletPara("Hub stores cluster tokens in-memory and optionally in PostgreSQL. Tokens are never exposed in API responses."),
      bulletPara("Agent pods run as non-root (UID 1001) with read-only filesystem."),
      bulletPara("No inbound ports need to be opened on the agent cluster for agent communication — agent initiates all connections."),
      bulletPara("No VPN, service mesh, or special network infrastructure is required."),

      // ═══════════════════════════════════════════════════════════
      // 13. VALIDATION
      // ═══════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("13. Validation & Testing Plan", 1),
      para("After firewall rules are applied, validate connectivity with the following tests:", { after: 120 }),
      dataTable(
        ["#", "Test", "Command (run from source)", "Expected"],
        [
          ["1", "Agent → Hub (:3000)", "curl -v http://10.131.71.72:3000/healthz\n(from any agent node)", "HTTP 200 OK"],
          ["2", "Agent → Hub Route", "curl -kv https://mcp-hub.apps.<domain>/healthz\n(from agent node)", "HTTP 200 OK"],
          ["3", "Hub → Agent K8s API", "curl -k https://10.131.73.21:6443/version\n(from SNO node)", "JSON with K8s version"],
          ["4", "DNS resolution", "nslookup mcp-hub.apps.<domain>\n(from agent node)", "Resolves to 10.131.71.72"],
          ["5", "TCP port check", "nc -zv 10.131.71.72 3000\n(from agent node)", "Connection succeeded"],
          ["6", "TCP port check", "nc -zv 10.131.73.21 6443\n(from SNO node)", "Connection succeeded"],
          ["7", "End-to-end", "Deploy agent pod → check Hub dashboard", "Cluster appears in UI"],
        ],
        [5, 22, 43, 30],
        { headerColor: C.teal }
      ),

      // ── Footer ──
      new Paragraph({ spacing: { before: 600 } }),
      new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: [
        new TableCell({
          children: [
            new Paragraph({ children: [new TextRun({ text: "— End of Document —", size: 20, color: C.white, italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 20 } }),
            new Paragraph({ children: [new TextRun({ text: "Generated by TCS KubeNexus AI Platform", size: 18, color: "93C5FD" })], alignment: AlignmentType.CENTER, spacing: { after: 0 } }),
          ],
          shading: { fill: C.navyDark, type: ShadingType.CLEAR },
          borders: noBorders,
          margins: { top: 80, bottom: 80, left: 100, right: 100 },
        }),
      ]})] }),
    ],
  }],
});

const buffer = await Packer.toBuffer(doc);
const outPath = "docs/TCS-KubeNexus-AI-Multi-Cluster-Network-Architecture.docx";
await writeFile(outPath, buffer);
console.log("Created: " + outPath + " (" + buffer.length + " bytes)");
