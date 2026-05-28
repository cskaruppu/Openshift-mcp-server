import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, WidthType, BorderStyle, AlignmentType, PageBreak, VerticalAlign, ShadingType, ImageRun } from "docx";
import { writeFile } from "node:fs/promises";
import { createCanvas } from "canvas";

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

// ── Generate Architecture Diagram as PNG (Enterprise / Industry Standard) ──
function generateArchDiagram() {
  const W = 1600, H = 1200;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // ── Subtle dot grid ──
  ctx.fillStyle = "#E5E7EB";
  for (let gx = 0; gx < W; gx += 20) for (let gy = 0; gy < H; gy += 20) { ctx.beginPath(); ctx.arc(gx, gy, 0.5, 0, Math.PI * 2); ctx.fill(); }

  // ════════════════════════════════════════════════════════════════
  // TITLE BAR — dark navy with Red Hat branding
  // ════════════════════════════════════════════════════════════════
  const titleH = 64;
  ctx.fillStyle = "#0F1B2D";
  rr(ctx, 0, 0, W, titleH, 0); ctx.fill();
  // Red accent bar
  ctx.fillStyle = "#EE0000";
  ctx.fillRect(0, titleH - 4, W, 4);
  // Title text
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 24px Arial";
  ctx.textAlign = "center";
  ctx.fillText("TCS KubeNexus AI — Multi-Cluster Network Architecture", W / 2, 40);
  ctx.font = "13px Arial";
  ctx.fillStyle = "#93C5FD";
  ctx.textAlign = "right";
  ctx.fillText("Hub-and-Spoke Model  |  Confidential — Internal", W - 30, 40);

  // ════════════════════════════════════════════════════════════════
  // NETWORK BOUNDARY — dashed line with firewall in center
  // ════════════════════════════════════════════════════════════════
  const fwX = W / 2, fwTopY = 88, fwBotY = 725;
  ctx.strokeStyle = "#DC2626";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 5]);
  ctx.beginPath(); ctx.moveTo(fwX, fwTopY); ctx.lineTo(fwX, fwBotY); ctx.stroke();
  ctx.setLineDash([]);
  // Firewall icon (shield shape) in center
  const shX = fwX, shY = 395;
  drawFirewallIcon(ctx, shX, shY);

  // "Network Boundary" label
  ctx.save();
  ctx.translate(fwX + 14, 620);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = "#DC2626";
  ctx.font = "bold 11px Arial";
  ctx.textAlign = "center";
  ctx.fillText("NETWORK  BOUNDARY  /  FIREWALL", 0, 0);
  ctx.restore();

  // ════════════════════════════════════════════════════════════════
  // HUB CLUSTER ZONE (left) — Red Hat OpenShift branded
  // ════════════════════════════════════════════════════════════════
  const hubX = 30, hubY = 80, hubW = 740, hubH = 560;
  // Zone background
  ctx.fillStyle = "#FEF2F2";
  rr(ctx, hubX, hubY, hubW, hubH, 12); ctx.fill();
  ctx.strokeStyle = "#EE0000";
  ctx.lineWidth = 2.5;
  rr(ctx, hubX, hubY, hubW, hubH, 12); ctx.stroke();
  // Zone header bar
  ctx.fillStyle = "#EE0000";
  rr(ctx, hubX, hubY, hubW, 44, 12); ctx.fill();
  ctx.fillRect(hubX, hubY + 24, hubW, 20);
  // OpenShift logo in header
  drawOpenShiftLogo(ctx, hubX + 14, hubY + 6, 32, "#FFFFFF");
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 16px Arial";
  ctx.textAlign = "left";
  ctx.fillText("Red Hat OpenShift — SNO Hub Cluster", hubX + 52, hubY + 28);
  // Subtitle
  ctx.fillStyle = "#991B1B";
  ctx.font = "12px Arial";
  ctx.fillText("Single Node OpenShift  |  10.131.71.72  |  Namespace: openshift-mcp", hubX + 18, hubY + 62);

  // ── Hub components ──
  const hcY = hubY + 82;
  // Row 1: MCP Server (main)
  drawServerBox(ctx, hubX + 22, hcY, 175, 100, "MCP Server (Hub)", "Port 3000", "Core MCP Application", "#B91C1C", "#FEE2E2", "#EF4444");
  drawServerBox(ctx, hubX + 210, hcY, 175, 100, "Dashboard & AI Chat", "Web UI", "Unified Management", "#B91C1C", "#FEE2E2", "#EF4444");
  drawServerBox(ctx, hubX + 398, hcY, 175, 100, "Multi-Cluster Hub", "Registry", "Agent Aggregation", "#B91C1C", "#FEE2E2", "#EF4444");
  drawServerBox(ctx, hubX + 554, hcY, 175, 100, "Deploy Orchestrator", "Engine", "Doc-Driven Deploy", "#B91C1C", "#FEE2E2", "#EF4444");
  // Row 2
  const hcY2 = hcY + 115;
  drawCylinderDB(ctx, hubX + 22, hcY2, 160, 85, "PostgreSQL", "Port 5432", "#7C3AED", "#EDE9FE");
  drawRouteBox(ctx, hubX + 198, hcY2, 180, 85, "OpenShift Route", "HTTPS :443 → :3000", "HAProxy TLS Edge", "#EE0000");
  drawSmallBox(ctx, hubX + 395, hcY2, 175, 85, "ServiceAccount", "RBAC: cluster-admin", "#1E40AF", "#DBEAFE");
  drawSmallBox(ctx, hubX + 582, hcY2, 145, 85, "ConfigMap\n& Secrets", "Env config", "#6B7280", "#F3F4F6");

  // Node box for SNO
  drawNodeIcon(ctx, hubX + 22, hcY2 + 105, 706, 55, "SNO Node: 10.131.71.72", "RHCOS  |  Control + Compute + Infra  |  Roles: master,worker", "#7F1D1D", "#FEF2F2", "#EF4444");

  // ════════════════════════════════════════════════════════════════
  // AGENT CLUSTER ZONE (right) — Red Hat OpenShift branded
  // ════════════════════════════════════════════════════════════════
  const agX = 830, agY = 80, agW = 740, agH = 560;
  ctx.fillStyle = "#ECFDF5";
  rr(ctx, agX, agY, agW, agH, 12); ctx.fill();
  ctx.strokeStyle = "#15803D";
  ctx.lineWidth = 2.5;
  rr(ctx, agX, agY, agW, agH, 12); ctx.stroke();
  // Header bar
  ctx.fillStyle = "#15803D";
  rr(ctx, agX, agY, agW, 44, 12); ctx.fill();
  ctx.fillRect(agX, agY + 24, agW, 20);
  drawOpenShiftLogo(ctx, agX + 14, agY + 6, 32, "#FFFFFF");
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 16px Arial";
  ctx.textAlign = "left";
  ctx.fillText("Red Hat OpenShift — 3-Node Agent Cluster", agX + 52, agY + 28);
  ctx.fillStyle = "#166534";
  ctx.font = "12px Arial";
  ctx.fillText("High Availability  |  10.131.73.21 / .22 / .23  |  Namespace: openshift-mcp-agent", agX + 18, agY + 62);

  // ── Agent components ──
  const acY = agY + 82;
  drawServerBox(ctx, agX + 22, acY, 175, 100, "MCP Agent Pod", "Port 8080", "Scanner + Reporter", "#166534", "#D1FAE5", "#22C55E");
  drawServerBox(ctx, agX + 210, acY, 175, 100, "Cluster Scanner", "60s Interval", "Nodes, Pods, Events", "#166534", "#D1FAE5", "#22C55E");
  drawServerBox(ctx, agX + 398, acY, 175, 100, "Hub Reporter", "HTTP POST", "JSON Reports to Hub", "#166534", "#D1FAE5", "#22C55E");
  drawServerBox(ctx, agX + 554, acY, 175, 100, "Health Endpoints", "/healthz /readyz", "/status  /scan", "#166534", "#D1FAE5", "#22C55E");

  const acY2 = acY + 115;
  drawSmallBox(ctx, agX + 22, acY2, 230, 85, "Kubernetes API Server", "Port 6443 — Master: 10.131.73.21", "#1E40AF", "#DBEAFE");
  drawSmallBox(ctx, agX + 265, acY2, 175, 85, "ServiceAccount", "RBAC: cluster-reader (RO)", "#6B7280", "#F3F4F6");
  drawSmallBox(ctx, agX + 453, acY2, 145, 85, "ConfigMap\n& Secrets", "HUB_SERVER_URL", "#6B7280", "#F3F4F6");
  drawSmallBox(ctx, agX + 610, acY2, 118, 85, "TLS Certs", "SA Auto-mount", "#0D9488", "#CCFBF1");

  // Node boxes
  const nY = acY2 + 105;
  drawNodeIcon(ctx, agX + 22, nY, 226, 55, "Master: 10.131.73.21", "RHCOS  |  Control Plane  |  etcd, API, scheduler", "#14532D", "#ECFDF5", "#22C55E");
  drawNodeIcon(ctx, agX + 260, nY, 226, 55, "Worker 1: 10.131.73.22", "RHCOS  |  Compute Node  |  Agent Pod runs here", "#14532D", "#ECFDF5", "#22C55E");
  drawNodeIcon(ctx, agX + 498, nY, 226, 55, "Worker 2: 10.131.73.23", "RHCOS  |  Compute Node  |  Failover / scale", "#14532D", "#ECFDF5", "#22C55E");

  // ════════════════════════════════════════════════════════════════
  // COMMUNICATION ARROWS (between clusters, through firewall)
  // ════════════════════════════════════════════════════════════════
  // Arrow 1: Agent → Hub (HTTP POST :3000) — agent-initiated
  drawLabeledArrow(ctx, agX - 6, 230, hubX + hubW + 6, 230, "#2563EB", 2.5, [],
    "TCP 3000  |  HTTP POST",
    "Agent Registration (once) + Periodic Reports (every 60s)");

  // Arrow 2: Hub → K8s API (HTTPS GET :6443) — hub-initiated
  drawLabeledArrow(ctx, hubX + hubW + 6, 310, agX - 6, 310, "#C2410C", 2.5, [],
    "TCP 6443  |  HTTPS GET",
    "Health Probes + Remote Cluster Queries (every 60s)");

  // Arrow 3: Hub → Agent Route (optional HTTPS)
  drawLabeledArrow(ctx, hubX + hubW + 6, 380, agX - 6, 380, "#7C3AED", 1.5, [6, 4],
    "TCP 443  |  HTTPS (optional)",
    "Hub → Agent via OpenShift Route (if configured)");

  // ════════════════════════════════════════════════════════════════
  // EXTERNAL ENTITIES — Browser and Azure OpenAI
  // ════════════════════════════════════════════════════════════════

  // Browser / End User
  const brX = 80, brY = 700, brW = 200, brH = 90;
  drawExternalEntity(ctx, brX, brY, brW, brH, "End User / Browser", "Dashboard Access via HTTPS", "#6D28D9", "#EDE9FE", "#8B5CF6");
  drawGlobeIcon(ctx, brX + 15, brY + 20, 22, "#6D28D9");

  // Arrow: Browser → Hub Route
  drawBentArrow(ctx, brX + brW, brY + 30, hubX + hubW / 2, hubY + hubH, "#6D28D9", "HTTPS :443 — TLS Edge");

  // Azure OpenAI
  const azX = 400, azY = 700, azW = 240, azH = 90;
  drawExternalEntity(ctx, azX, azY, azW, azH, "Azure OpenAI Service", "AI Chat & Document Analysis", "#0369A1", "#E0F2FE", "#0EA5E9");
  drawCloudIcon(ctx, azX + 15, azY + 18, 28, "#0369A1");

  // Arrow: Hub → Azure OpenAI
  drawBentArrow(ctx, azX + azW / 2, azY, hubX + hubW / 2 + 120, hubY + hubH, "#0369A1", "HTTPS :443 — LLM API");

  // Kubernetes logo area
  const k8X = 1100, k8Y = 700, k8W = 240, k8H = 90;
  drawExternalEntity(ctx, k8X, k8Y, k8W, k8H, "Kubernetes API (Agent)", "Cluster State & Resource Data", "#1E40AF", "#DBEAFE", "#3B82F6");
  drawK8sWheel(ctx, k8X + 15, k8Y + 18, 14, "#1E40AF");

  // Arrow: Agent → Local K8s API (internal)
  drawBentArrowUp(ctx, k8X + k8W / 2, k8Y, agX + agW / 2, agY + agH, "#1E40AF", "HTTPS :6443 — Internal");

  // ════════════════════════════════════════════════════════════════
  // LEGEND
  // ════════════════════════════════════════════════════════════════
  const legY = 830;
  ctx.fillStyle = "#FFFFFF";
  rr(ctx, 30, legY, W - 60, 170, 10); ctx.fill();
  ctx.strokeStyle = "#D1D5DB";
  ctx.lineWidth = 1;
  rr(ctx, 30, legY, W - 60, 170, 10); ctx.stroke();
  // Legend header
  ctx.fillStyle = "#0F1B2D";
  ctx.font = "bold 14px Arial";
  ctx.textAlign = "left";
  ctx.fillText("LEGEND", 55, legY + 22);

  // Connection types
  const lx = 55, lGap = 28;
  let ly = legY + 48;
  drawLegendLine(ctx, lx, ly, "#2563EB", [], "Agent → Hub (TCP 3000 / HTTP POST) — Registration & Reports"); ly += lGap;
  drawLegendLine(ctx, lx, ly, "#C2410C", [], "Hub → Agent K8s API (TCP 6443 / HTTPS) — Health Probes & Queries"); ly += lGap;
  drawLegendLine(ctx, lx, ly, "#7C3AED", [6, 4], "Optional / Secondary Connections (TCP 443)"); ly += lGap;
  drawLegendLine(ctx, lx, ly, "#DC2626", [8, 5], "Network Boundary / Firewall Zone"); ly += lGap;

  // Icons legend (right column)
  const rx = 780;
  ly = legY + 48;
  drawOpenShiftLogo(ctx, rx, ly - 10, 18, "#EE0000");
  ctx.fillStyle = "#374151"; ctx.font = "13px Arial"; ctx.textAlign = "left";
  ctx.fillText("Red Hat OpenShift Container Platform", rx + 28, ly + 4); ly += lGap;
  drawFirewallIconSmall(ctx, rx + 4, ly - 8, "#DC2626");
  ctx.fillText("Network Firewall / Security Boundary", rx + 28, ly + 4); ly += lGap;
  drawCylinderSmall(ctx, rx + 4, ly - 8, "#7C3AED");
  ctx.fillText("Database (PostgreSQL)", rx + 28, ly + 4); ly += lGap;
  drawCloudIcon(ctx, rx + 2, ly - 10, 18, "#0369A1");
  ctx.fillText("External Cloud Service", rx + 28, ly + 4); ly += lGap;

  // Required ports box
  const px = 1150;
  ctx.fillStyle = "#FEF2F2";
  rr(ctx, px, legY + 30, 290, 120, 8); ctx.fill();
  ctx.strokeStyle = "#EF4444";
  ctx.lineWidth = 1;
  rr(ctx, px, legY + 30, 290, 120, 8); ctx.stroke();
  ctx.fillStyle = "#991B1B";
  ctx.font = "bold 13px Arial";
  ctx.fillText("REQUIRED FIREWALL PORTS", px + 15, legY + 52);
  ctx.font = "12px Arial";
  ctx.fillStyle = "#374151";
  ctx.fillText("TCP 3000   Hub MCP Server API", px + 15, legY + 74);
  ctx.fillText("TCP 6443   Kubernetes API Server", px + 15, legY + 94);
  ctx.fillText("TCP 443    HTTPS Route / TLS (optional)", px + 15, legY + 114);
  ctx.fillText("Protocol   HTTP/HTTPS over TCP", px + 15, legY + 134);

  // ════════════════════════════════════════════════════════════════
  // FOOTER
  // ════════════════════════════════════════════════════════════════
  ctx.fillStyle = "#0F1B2D";
  rr(ctx, 0, H - 40, W, 40, 0); ctx.fill();
  ctx.fillStyle = "#EE0000";
  ctx.fillRect(0, H - 40, W, 3);
  ctx.fillStyle = "#93C5FD";
  ctx.font = "12px Arial";
  ctx.textAlign = "center";
  ctx.fillText("TCS KubeNexus AI Platform  |  Red Hat OpenShift Container Platform  |  Hub-and-Spoke Architecture  |  All communication is agent-initiated", W / 2, H - 16);

  return canvas.toBuffer("image/png");
}

// ── Drawing Primitives ──

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── OpenShift Logo (stylized angular "O" — recognizable silhouette) ──
function drawOpenShiftLogo(ctx, x, y, size, color) {
  const s = size / 32;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  // Outer ring
  ctx.beginPath();
  ctx.arc(16 * s, 16 * s, 14 * s, 0, Math.PI * 2);
  ctx.fill();
  // Inner cutout (darker)
  ctx.fillStyle = color === "#FFFFFF" ? "#EE0000" : "#FFFFFF";
  ctx.beginPath();
  ctx.arc(16 * s, 16 * s, 9 * s, 0, Math.PI * 2);
  ctx.fill();
  // Arrow notch (the distinctive OpenShift arrow)
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(14 * s, 7 * s);
  ctx.lineTo(24 * s, 12 * s);
  ctx.lineTo(14 * s, 17 * s);
  ctx.closePath();
  ctx.fill();
  // Lower arrow
  ctx.fillStyle = color === "#FFFFFF" ? "#EE0000" : "#FFFFFF";
  ctx.beginPath();
  ctx.moveTo(18 * s, 15 * s);
  ctx.lineTo(8 * s, 20 * s);
  ctx.lineTo(18 * s, 25 * s);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ── Firewall / Shield Icon ──
function drawFirewallIcon(ctx, cx, cy) {
  const w = 44, h = 52;
  ctx.fillStyle = "#FFFFFF";
  rr(ctx, cx - w / 2 - 4, cy - h / 2 - 8, w + 8, h + 16, 8); ctx.fill();
  ctx.strokeStyle = "#DC2626"; ctx.lineWidth = 1.5;
  rr(ctx, cx - w / 2 - 4, cy - h / 2 - 8, w + 8, h + 16, 8); ctx.stroke();
  // Shield shape
  ctx.fillStyle = "#DC2626";
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2);
  ctx.quadraticCurveTo(cx + w / 2, cy - h / 2 + 4, cx + w / 2, cy - 4);
  ctx.quadraticCurveTo(cx + w / 2, cy + h / 3, cx, cy + h / 2);
  ctx.quadraticCurveTo(cx - w / 2, cy + h / 3, cx - w / 2, cy - 4);
  ctx.quadraticCurveTo(cx - w / 2, cy - h / 2 + 4, cx, cy - h / 2);
  ctx.closePath();
  ctx.fill();
  // Lock icon inside shield
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 18px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("FW", cx, cy + 2);
  ctx.textBaseline = "alphabetic";
  // Label
  ctx.fillStyle = "#DC2626";
  ctx.font = "bold 9px Arial";
  ctx.fillText("FIREWALL", cx, cy + h / 2 + 14);
}

function drawFirewallIconSmall(ctx, x, y, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + 8, y);
  ctx.quadraticCurveTo(x + 16, y + 2, x + 16, y + 8);
  ctx.quadraticCurveTo(x + 16, y + 14, x + 8, y + 18);
  ctx.quadraticCurveTo(x, y + 14, x, y + 8);
  ctx.quadraticCurveTo(x, y + 2, x + 8, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 7px Arial";
  ctx.textAlign = "center";
  ctx.fillText("FW", x + 8, y + 11);
}

// ── Server Box (component) ──
function drawServerBox(ctx, x, y, w, h, title, sub1, sub2, textColor, bg, accent) {
  ctx.fillStyle = bg;
  rr(ctx, x, y, w, h, 8); ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  rr(ctx, x, y, w, h, 8); ctx.stroke();
  // Top accent bar
  ctx.fillStyle = accent;
  rr(ctx, x, y, w, 5, 8); ctx.fill();
  // Server icon
  ctx.fillStyle = accent;
  const ix = x + 14, iy = y + 20;
  rr(ctx, ix, iy, 18, 6, 2); ctx.fill();
  rr(ctx, ix, iy + 9, 18, 6, 2); ctx.fill();
  rr(ctx, ix, iy + 18, 18, 6, 2); ctx.fill();
  // LED dots
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath(); ctx.arc(ix + 13, iy + 3, 1.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(ix + 13, iy + 12, 1.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(ix + 13, iy + 21, 1.5, 0, Math.PI * 2); ctx.fill();
  // Text
  ctx.fillStyle = textColor;
  ctx.font = "bold 12px Arial";
  ctx.textAlign = "left";
  ctx.fillText(title, x + 40, y + 30);
  ctx.font = "11px Arial";
  ctx.fillStyle = "#6B7280";
  ctx.fillText(sub1, x + 40, y + 48);
  ctx.fillText(sub2, x + 40, y + 64);
  // Port badge
  if (sub1.match(/Port|:(\d+)/)) {
    const port = sub1.match(/\d+/);
    if (port) {
      ctx.fillStyle = accent;
      rr(ctx, x + w - 50, y + h - 24, 42, 18, 9); ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.font = "bold 9px Arial";
      ctx.textAlign = "center";
      ctx.fillText(":" + port[0], x + w - 29, y + h - 12);
    }
  }
}

// ── Database Cylinder ──
function drawCylinderDB(ctx, x, y, w, h, title, sub, color, bg) {
  const ey = 10;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + ey, w / 2, ey, 0, Math.PI, 0);
  ctx.lineTo(x + w, y + h - ey);
  ctx.ellipse(x + w / 2, y + h - ey, w / 2, ey, 0, 0, Math.PI);
  ctx.lineTo(x, y + ey);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Top ellipse
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + ey, w / 2, ey, 0, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.15;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.stroke();
  // Text
  ctx.fillStyle = color;
  ctx.font = "bold 13px Arial";
  ctx.textAlign = "center";
  ctx.fillText(title, x + w / 2, y + h / 2 + 4);
  ctx.font = "11px Arial";
  ctx.fillStyle = "#6B7280";
  ctx.fillText(sub, x + w / 2, y + h / 2 + 20);
}

function drawCylinderSmall(ctx, x, y, color) {
  ctx.strokeStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(x + 8, y + 4, 8, 4, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y + 4); ctx.lineTo(x, y + 16);
  ctx.ellipse(x + 8, y + 16, 8, 4, 0, Math.PI, 0);
  ctx.lineTo(x + 16, y + 4);
  ctx.stroke();
}

// ── Route Box (with lock icon) ──
function drawRouteBox(ctx, x, y, w, h, title, sub, sub2, color) {
  ctx.fillStyle = "#FFF1F2";
  rr(ctx, x, y, w, h, 8); ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  rr(ctx, x, y, w, h, 8); ctx.stroke();
  // Lock icon
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x + 22, y + 26, 8, Math.PI, 0); ctx.stroke();
  ctx.fillStyle = color;
  rr(ctx, x + 10, y + 26, 24, 16, 3); ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath(); ctx.arc(x + 22, y + 33, 3, 0, Math.PI * 2); ctx.fill();
  // Text
  ctx.fillStyle = "#991B1B";
  ctx.font = "bold 12px Arial";
  ctx.textAlign = "left";
  ctx.fillText(title, x + 42, y + 30);
  ctx.font = "11px Arial";
  ctx.fillStyle = "#6B7280";
  ctx.fillText(sub, x + 42, y + 48);
  ctx.fillText(sub2, x + 42, y + 64);
}

// ── Small Box (generic) ──
function drawSmallBox(ctx, x, y, w, h, title, sub, color, bg) {
  ctx.fillStyle = bg;
  rr(ctx, x, y, w, h, 6); ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  rr(ctx, x, y, w, h, 6); ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = "bold 11px Arial";
  ctx.textAlign = "center";
  const lines = title.split("\n");
  lines.forEach((l, i) => ctx.fillText(l, x + w / 2, y + 28 + i * 16));
  ctx.font = "10px Arial";
  ctx.fillStyle = "#6B7280";
  ctx.fillText(sub, x + w / 2, y + h - 14);
}

// ── Node Icon (server rack style) ──
function drawNodeIcon(ctx, x, y, w, h, title, sub, color, bg, accent) {
  ctx.fillStyle = bg;
  rr(ctx, x, y, w, h, 6); ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 3]);
  rr(ctx, x, y, w, h, 6); ctx.stroke();
  ctx.setLineDash([]);
  // Server rack mini-icon
  ctx.fillStyle = accent;
  rr(ctx, x + 10, y + 12, 22, 7, 2); ctx.fill();
  rr(ctx, x + 10, y + 22, 22, 7, 2); ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath(); ctx.arc(x + 27, y + 15.5, 1.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x + 27, y + 25.5, 1.5, 0, Math.PI * 2); ctx.fill();
  // Text
  ctx.fillStyle = color;
  ctx.font = "bold 12px Arial";
  ctx.textAlign = "left";
  ctx.fillText(title, x + 40, y + 22);
  ctx.font = "10px Arial";
  ctx.fillStyle = "#6B7280";
  ctx.fillText(sub, x + 40, y + 38);
}

// ── External Entity Box ──
function drawExternalEntity(ctx, x, y, w, h, title, sub, color, bg, accent) {
  ctx.fillStyle = bg;
  rr(ctx, x, y, w, h, 10); ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  rr(ctx, x, y, w, h, 10); ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = "bold 13px Arial";
  ctx.textAlign = "left";
  ctx.fillText(title, x + 48, y + 38);
  ctx.font = "11px Arial";
  ctx.fillStyle = "#6B7280";
  ctx.fillText(sub, x + 48, y + 58);
}

// ── Globe Icon ──
function drawGlobeIcon(ctx, x, y, r, color) {
  ctx.strokeStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(x + r, y + r, r, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(x + r, y + r, r * 0.45, r, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, y + r); ctx.lineTo(x + r * 2, y + r); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + r, y + r * 2); ctx.stroke();
}

// ── Cloud Icon ──
function drawCloudIcon(ctx, x, y, size, color) {
  const s = size / 28;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x + 10 * s, y + 18 * s, 8 * s, Math.PI * 0.5, Math.PI * 1.5);
  ctx.arc(x + 10 * s, y + 10 * s, 10 * s, Math.PI, Math.PI * 1.5);
  ctx.arc(x + 20 * s, y + 8 * s, 8 * s, Math.PI * 1.2, 0);
  ctx.arc(x + 22 * s, y + 18 * s, 8 * s, Math.PI * 1.5, Math.PI * 0.5);
  ctx.lineTo(x + 2 * s, y + 26 * s);
  ctx.closePath();
  ctx.globalAlpha = 0.2;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ── Kubernetes Wheel Icon ──
function drawK8sWheel(ctx, x, y, r, color) {
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x + r, y + r, r, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(x + r, y + r, r * 0.35, 0, Math.PI * 2); ctx.fill();
  for (let i = 0; i < 7; i++) {
    const a = (Math.PI * 2 * i) / 7 - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(x + r + Math.cos(a) * r * 0.45, y + r + Math.sin(a) * r * 0.45);
    ctx.lineTo(x + r + Math.cos(a) * r * 0.9, y + r + Math.sin(a) * r * 0.9);
    ctx.stroke();
  }
}

// ── Labeled Arrow (straight, with protocol badge) ──
function drawLabeledArrow(ctx, x1, y1, x2, y2, color, lw, dash, label, sublabel) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.setLineDash(dash);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.setLineDash([]);
  // Arrowhead
  const ang = Math.atan2(y2 - y1, x2 - x1);
  ctx.fillStyle = color;
  ctx.save(); ctx.translate(x2, y2); ctx.rotate(ang);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-12, -6); ctx.lineTo(-12, 6); ctx.closePath(); ctx.fill();
  ctx.restore();
  // Label badge
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  ctx.font = "bold 11px Arial";
  const tw = ctx.measureText(label).width + 16;
  ctx.fillStyle = "#FFFFFF";
  rr(ctx, mx - tw / 2, my - 22, tw, 19, 4); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1;
  rr(ctx, mx - tw / 2, my - 22, tw, 19, 4); ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.fillText(label, mx, my - 8);
  ctx.font = "10px Arial";
  ctx.fillStyle = "#6B7280";
  ctx.fillText(sublabel, mx, my + 8);
}

// ── Bent Arrow (for external entities connecting to zones) ──
function drawBentArrow(ctx, x1, y1, x2, y2, color, label) {
  const midY = y1 - 30;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 3]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 + 30, midY);
  ctx.lineTo(x2, y2 + 15);
  ctx.stroke();
  ctx.setLineDash([]);
  // Arrowhead
  ctx.fillStyle = color;
  ctx.save(); ctx.translate(x2, y2 + 15);
  ctx.rotate(-Math.PI / 2);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-8, -4); ctx.lineTo(-8, 4); ctx.closePath(); ctx.fill();
  ctx.restore();
  // Label
  const lx = (x1 + x2) / 2 + 20, ly = midY - 6;
  ctx.font = "bold 9px Arial";
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.fillText(label, lx, ly);
}

function drawBentArrowUp(ctx, x1, y1, x2, y2, color, label) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 3]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2 + 15);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.save(); ctx.translate(x2, y2 + 15);
  ctx.rotate(-Math.PI / 2);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-8, -4); ctx.lineTo(-8, 4); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.font = "bold 9px Arial";
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.fillText(label, (x1 + x2) / 2 + 20, (y1 + y2) / 2 + 10);
}

// ── Legend Line ──
function drawLegendLine(ctx, x, y, color, dash, label) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.setLineDash(dash);
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 50, y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.save(); ctx.translate(x + 50, y);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-8, -4); ctx.lineTo(-8, 4); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.fillStyle = "#374151";
  ctx.font = "13px Arial";
  ctx.textAlign = "left";
  ctx.fillText(label, x + 60, y + 5);
}

const diagramPng = generateArchDiagram();

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
      // 4. ARCHITECTURE DIAGRAM — embedded PNG image
      // ═══════════════════════════════════════════════════════════
      heading("4. Architecture Diagram", 1),
      para("The following diagram shows the high-level architecture with all components, communication paths, ports, and protocols.", { after: 120 }),

      new Paragraph({
        children: [
          new ImageRun({
            data: diagramPng,
            transformation: { width: 740, height: 555 },
            type: "png",
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
      }),
      para("Figure 1: Hub-and-Spoke Multi-Cluster Architecture — SNO Hub + 3-Node Agent Cluster", { italic: true, color: C.gray, after: 200, align: AlignmentType.CENTER }),

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
