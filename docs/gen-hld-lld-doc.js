import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, WidthType, BorderStyle, AlignmentType, PageBreak, VerticalAlign, ShadingType, ImageRun } from "docx";
import { writeFile } from "node:fs/promises";
import { createCanvas } from "canvas";

const C = {
  navyDark: "0F1B2D", navy: "1e3a5f", blue: "2563eb", blueBg: "DBEAFE", blueLight: "EFF6FF",
  green: "15803d", greenBg: "D1FAE5", greenLight: "ECFDF5",
  orange: "C2410C", orangeBg: "FED7AA", orangeLight: "FFF7ED",
  purple: "7C3AED", purpleBg: "DDD6FE", purpleLight: "F5F3FF",
  red: "DC2626", redBg: "FEE2E2",
  teal: "0D9488", tealBg: "CCFBF1",
  gray: "6B7280", grayLight: "F9FAFB", grayBorder: "E5E7EB",
  white: "FFFFFF", black: "111827",
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

function archBox(title, subtitle, items, opts = {}) {
  const bg = opts.bg || C.blueBg;
  const borderColor = opts.border || C.blue;
  const titleColor = opts.titleColor || C.navy;
  const boxBorder = { style: BorderStyle.SINGLE, size: 3, color: borderColor };
  const boxBorders = { top: boxBorder, bottom: boxBorder, left: boxBorder, right: boxBorder };
  const children = [
    new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 24, color: titleColor, font: "Calibri" })], spacing: { after: 20 } }),
  ];
  if (subtitle) children.push(new Paragraph({ children: [new TextRun({ text: subtitle, size: 18, color: C.gray, font: "Calibri", italics: true })], spacing: { after: 40 } }));
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

function codeBlock(lines, accentColor) {
  const accent = accentColor || C.blue;
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: [
    new TableCell({
      children: lines.map(l => new Paragraph({ children: [new TextRun({ text: l, size: 18, color: C.black, font: "Consolas" })], spacing: { after: 8 } })),
      shading: { fill: "F8FAFC", type: ShadingType.CLEAR },
      borders: { top: { style: BorderStyle.SINGLE, size: 1, color: C.grayBorder }, bottom: { style: BorderStyle.SINGLE, size: 1, color: C.grayBorder }, left: { style: BorderStyle.SINGLE, size: 4, color: accent }, right: { style: BorderStyle.SINGLE, size: 1, color: C.grayBorder } },
      margins: { top: 80, bottom: 80, left: 140, right: 140 },
    }),
  ]})] });
}

// ══════════════════════════════════════════════════
// Canvas diagram helpers
// ══════════════════════════════════════════════════

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

function drawBox(ctx, x, y, w, h, title, subtitle, bg, border, titleColor) {
  ctx.fillStyle = bg;
  rr(ctx, x, y, w, h, 10); ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 2;
  rr(ctx, x, y, w, h, 10); ctx.stroke();
  ctx.fillStyle = border;
  rr(ctx, x, y, w, 32, 10); ctx.fill();
  ctx.fillRect(x, y + 16, w, 16);
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 13px Arial";
  ctx.textAlign = "center";
  ctx.fillText(title, x + w / 2, y + 22);
  if (subtitle) {
    ctx.fillStyle = titleColor || "#333";
    ctx.font = "11px Arial";
    ctx.fillText(subtitle, x + w / 2, y + 52);
  }
}

function drawArrow(ctx, x1, y1, x2, y2, color, dash, label) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash(dash || []);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.setLineDash([]);
  const ang = Math.atan2(y2 - y1, x2 - x1);
  ctx.fillStyle = color;
  ctx.save(); ctx.translate(x2, y2); ctx.rotate(ang);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-10, -5); ctx.lineTo(-10, 5); ctx.closePath(); ctx.fill();
  ctx.restore();
  if (label) {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    ctx.font = "10px Arial";
    const tw = ctx.measureText(label).width + 10;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(mx - tw / 2, my - 8, tw, 16);
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.fillText(label, mx, my + 4);
  }
}

// ── Diagram 1: System Context ──
function generateSystemContextDiagram() {
  const W = 1200, H = 700;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // background
  ctx.fillStyle = "#FAFAFA";
  ctx.fillRect(0, 0, W, H);

  // title bar
  ctx.fillStyle = "#0F1B2D";
  ctx.fillRect(0, 0, W, 48);
  ctx.fillStyle = "#EE0000"; ctx.fillRect(0, 44, W, 4);
  ctx.fillStyle = "#FFFFFF"; ctx.font = "bold 18px Arial"; ctx.textAlign = "center";
  ctx.fillText("TCS Agentic AI — System Context Diagram", W / 2, 32);

  // User
  ctx.fillStyle = "#EDE7F6";
  rr(ctx, 40, 80, 170, 70, 10); ctx.fill();
  ctx.strokeStyle = "#7C3AED"; ctx.lineWidth = 2;
  rr(ctx, 40, 80, 170, 70, 10); ctx.stroke();
  ctx.fillStyle = "#4A148C"; ctx.font = "bold 13px Arial"; ctx.textAlign = "center";
  ctx.fillText("Platform Operator", 125, 110);
  ctx.font = "11px Arial"; ctx.fillStyle = "#6B7280";
  ctx.fillText("(Browser / HTTPS)", 125, 130);

  // Hub Cluster Zone
  ctx.fillStyle = "#FFF3E0";
  rr(ctx, 260, 60, 460, 330, 14); ctx.fill();
  ctx.strokeStyle = "#F57C00"; ctx.lineWidth = 3;
  rr(ctx, 260, 60, 460, 330, 14); ctx.stroke();
  ctx.fillStyle = "#F57C00";
  rr(ctx, 260, 60, 460, 36, 14); ctx.fill();
  ctx.fillRect(260, 78, 460, 18);
  ctx.fillStyle = "#FFFFFF"; ctx.font = "bold 14px Arial"; ctx.textAlign = "center";
  ctx.fillText("HUB CLUSTER — Management Plane", 490, 84);

  // Hub components
  drawBox(ctx, 280, 115, 200, 65, "React Console", "Vite + React 18 + Nginx", "#E3F2FD", "#1976D2", "#0D47A1");
  drawBox(ctx, 500, 115, 200, 65, "Control Plane MCP", "Node.js · MCP_MODE=hub", "#E8F5E9", "#388E3C", "#1B5E20");
  drawBox(ctx, 280, 200, 130, 60, "PostgreSQL", "Settings · Chats · Audit", "#EDE9FE", "#7C3AED", "#4A148C");
  drawBox(ctx, 430, 200, 120, 60, "Redis", "Cache · Sessions", "#FCE4EC", "#C2185B", "#880E4F");
  drawBox(ctx, 570, 200, 130, 60, "Hub Agent", "MCP_MODE=spoke", "#E8F5E9", "#388E3C", "#1B5E20");
  drawBox(ctx, 280, 285, 200, 55, "45+ MCP Tools", "Cluster · AI · Security · GitOps", "#FFF8E1", "#F9A825", "#F57F17");
  drawBox(ctx, 500, 285, 200, 55, "Orchestrators", "Upgrade · Deploy · Action", "#FFF8E1", "#F9A825", "#F57F17");

  // LLM Provider
  ctx.fillStyle = "#E0F2FE";
  rr(ctx, 780, 80, 170, 70, 10); ctx.fill();
  ctx.strokeStyle = "#0EA5E9"; ctx.lineWidth = 2;
  rr(ctx, 780, 80, 170, 70, 10); ctx.stroke();
  ctx.fillStyle = "#0369A1"; ctx.font = "bold 13px Arial"; ctx.textAlign = "center";
  ctx.fillText("LLM Provider", 865, 108);
  ctx.font = "11px Arial"; ctx.fillStyle = "#6B7280";
  ctx.fillText("Claude / OpenAI / Azure", 865, 128);

  // Enterprise Integrations
  ctx.fillStyle = "#EDE9FE";
  rr(ctx, 780, 180, 170, 70, 10); ctx.fill();
  ctx.strokeStyle = "#8B5CF6"; ctx.lineWidth = 2;
  rr(ctx, 780, 180, 170, 70, 10); ctx.stroke();
  ctx.fillStyle = "#6D28D9"; ctx.font = "bold 13px Arial"; ctx.textAlign = "center";
  ctx.fillText("Enterprise Integrations", 865, 208);
  ctx.font = "11px Arial"; ctx.fillStyle = "#6B7280";
  ctx.fillText("ServiceNow · Slack · Ansible", 865, 228);

  // Spokes Zone
  ctx.fillStyle = "#E8F4FD";
  rr(ctx, 260, 420, 690, 120, 14); ctx.fill();
  ctx.strokeStyle = "#1976D2"; ctx.lineWidth = 2;
  rr(ctx, 260, 420, 690, 120, 14); ctx.stroke();
  ctx.fillStyle = "#1976D2";
  rr(ctx, 260, 420, 690, 30, 14); ctx.fill();
  ctx.fillRect(260, 436, 690, 14);
  ctx.fillStyle = "#FFFFFF"; ctx.font = "bold 13px Arial"; ctx.textAlign = "center";
  ctx.fillText("MANAGED FLEET — Data Plane (each cluster runs full MCP agent)", 605, 442);

  drawBox(ctx, 290, 465, 180, 55, "prod-east", "MCP agent (spoke)", "#DBEAFE", "#2563EB", "#1E40AF");
  drawBox(ctx, 500, 465, 180, 55, "staging-west", "MCP agent (spoke)", "#D1FAE5", "#22C55E", "#166534");
  drawBox(ctx, 710, 465, 180, 55, "dev-cluster", "MCP agent (spoke)", "#FED7AA", "#F97316", "#C2410C");

  // Arrows
  drawArrow(ctx, 210, 115, 278, 135, "#7C3AED", [], "HTTPS");
  drawArrow(ctx, 702, 145, 778, 115, "#0EA5E9", [], "LLM API");
  drawArrow(ctx, 702, 230, 778, 215, "#8B5CF6", [], "Webhooks");
  drawArrow(ctx, 490, 345, 380, 463, "#2563EB", [6, 4], "3-tier fabric");
  drawArrow(ctx, 490, 345, 590, 463, "#22C55E", [6, 4], "3-tier fabric");
  drawArrow(ctx, 490, 345, 800, 463, "#F97316", [6, 4], "3-tier fabric");

  // Legend
  ctx.fillStyle = "#FFFFFF";
  rr(ctx, 30, 600, W - 60, 80, 8); ctx.fill();
  ctx.strokeStyle = "#D1D5DB"; ctx.lineWidth = 1;
  rr(ctx, 30, 600, W - 60, 80, 8); ctx.stroke();
  ctx.fillStyle = "#0F1B2D"; ctx.font = "bold 12px Arial"; ctx.textAlign = "left";
  ctx.fillText("LEGEND", 50, 622);
  const items = [
    { x: 50, label: "Management Plane", color: "#F57C00" },
    { x: 250, label: "Data Plane (spokes)", color: "#1976D2" },
    { x: 470, label: "External Services", color: "#0EA5E9" },
    { x: 680, label: "3-tier comm fabric", color: "#388E3C" },
  ];
  items.forEach(({ x, label, color }) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, 640, 30, 12);
    ctx.fillStyle = "#374151"; ctx.font = "12px Arial"; ctx.textAlign = "left";
    ctx.fillText(label, x + 36, 651);
  });

  return canvas.toBuffer("image/png");
}

// ── Diagram 2: Three-Tier Communication Fabric ──
function generateThreeTierDiagram() {
  const W = 1100, H = 600;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#FAFAFA"; ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#0F1B2D"; ctx.fillRect(0, 0, W, 48);
  ctx.fillStyle = "#EE0000"; ctx.fillRect(0, 44, W, 4);
  ctx.fillStyle = "#FFFFFF"; ctx.font = "bold 18px Arial"; ctx.textAlign = "center";
  ctx.fillText("Three-Tier Communication Fabric — Priority Waterfall", W / 2, 32);

  // Request start
  ctx.fillStyle = "#F3E5F5";
  rr(ctx, 450, 70, 200, 50, 25); ctx.fill();
  ctx.strokeStyle = "#7B1FA2"; ctx.lineWidth = 2;
  rr(ctx, 450, 70, 200, 50, 25); ctx.stroke();
  ctx.fillStyle = "#4A148C"; ctx.font = "bold 14px Arial"; ctx.textAlign = "center";
  ctx.fillText("Request for Cluster X", 550, 100);

  // Decision: local?
  ctx.fillStyle = "#FFF8E1";
  ctx.beginPath();
  ctx.moveTo(550, 150); ctx.lineTo(640, 190); ctx.lineTo(550, 230); ctx.lineTo(460, 190);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#F9A825"; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = "#F57F17"; ctx.font = "bold 11px Arial";
  ctx.fillText("cluster == local?", 550, 188);
  ctx.fillText("(self-identity)", 550, 202);

  drawArrow(ctx, 550, 120, 550, 150, "#7B1FA2", []);

  // Yes → local handler
  ctx.fillStyle = "#E3F2FD";
  rr(ctx, 700, 165, 180, 50, 8); ctx.fill();
  ctx.strokeStyle = "#1976D2"; ctx.lineWidth = 1.5;
  rr(ctx, 700, 165, 180, 50, 8); ctx.stroke();
  ctx.fillStyle = "#0D47A1"; ctx.font = "12px Arial"; ctx.textAlign = "center";
  ctx.fillText("Handle in-process", 790, 188);
  ctx.fillText("(remap to hub-cluster)", 790, 202);
  drawArrow(ctx, 640, 190, 698, 190, "#1976D2", [], "yes");

  // No → Tier 1
  drawArrow(ctx, 550, 230, 550, 270, "#F9A825", [], "no");

  // Tier 1 box
  ctx.fillStyle = "#E8F5E9";
  rr(ctx, 370, 270, 360, 70, 10); ctx.fill();
  ctx.strokeStyle = "#388E3C"; ctx.lineWidth = 2.5;
  rr(ctx, 370, 270, 360, 70, 10); ctx.stroke();
  ctx.fillStyle = "#388E3C"; ctx.font = "bold 14px Arial"; ctx.textAlign = "left";
  ctx.fillText("TIER 1 — Spoke Proxy", 395, 296);
  ctx.fillStyle = "#1B5E20"; ctx.font = "12px Arial";
  ctx.fillText("proxyToSpoke(): full HTTP relay to spoke's MCP server", 395, 316);
  ctx.fillText("hasSpoke(X)? → yes → Full data-plane agent is running", 395, 332);

  // Fallback arrow from Tier 1
  ctx.fillStyle = "#DC2626"; ctx.font = "bold 10px Arial"; ctx.textAlign = "center";
  drawArrow(ctx, 550, 340, 550, 370, "#DC2626", [4, 3], "502/504 or no spoke");

  // Tier 2 box
  ctx.fillStyle = "#FFF8E1";
  rr(ctx, 370, 370, 360, 70, 10); ctx.fill();
  ctx.strokeStyle = "#F9A825"; ctx.lineWidth = 2.5;
  rr(ctx, 370, 370, 360, 70, 10); ctx.stroke();
  ctx.fillStyle = "#F57F17"; ctx.font = "bold 14px Arial"; ctx.textAlign = "left";
  ctx.fillText("TIER 2 — Direct Access", 395, 396);
  ctx.fillStyle = "#E65100"; ctx.font = "12px Arial";
  ctx.fillText("enterRemoteClusterDirect(apiUrl, token)", 395, 416);
  ctx.fillText("hasCredentials(X)? → yes → Hub calls K8s API directly", 395, 432);

  drawArrow(ctx, 550, 440, 550, 470, "#DC2626", [4, 3], "no credentials");

  // Tier 3 box
  ctx.fillStyle = "#E3F2FD";
  rr(ctx, 370, 470, 360, 70, 10); ctx.fill();
  ctx.strokeStyle = "#1976D2"; ctx.lineWidth = 2.5;
  rr(ctx, 370, 470, 360, 70, 10); ctx.stroke();
  ctx.fillStyle = "#0D47A1"; ctx.font = "bold 14px Arial"; ctx.textAlign = "left";
  ctx.fillText("TIER 3 — Agent Bridge (SSE)", 395, 496);
  ctx.fillStyle = "#1565C0"; ctx.font = "12px Arial";
  ctx.fillText("enterRemoteClusterBridge(X)", 395, 516);
  ctx.fillText("hasActiveChannel(X)? → yes → Tool calls over SSE tunnel", 395, 532);

  // Fallback box
  ctx.fillStyle = "#F5F5F5";
  rr(ctx, 790, 470, 180, 70, 10); ctx.fill();
  ctx.strokeStyle = "#9E9E9E"; ctx.lineWidth = 1.5;
  rr(ctx, 790, 470, 180, 70, 10); ctx.stroke();
  ctx.fillStyle = "#616161"; ctx.font = "bold 12px Arial"; ctx.textAlign = "center";
  ctx.fillText("FALLBACK", 880, 498);
  ctx.font = "11px Arial";
  ctx.fillText("Serve cached snapshot", 880, 516);
  ctx.fillText("or return 503", 880, 530);
  drawArrow(ctx, 730, 505, 788, 505, "#9E9E9E", [4, 3], "no channel");

  // Priority badges
  const badges = [
    { x: 340, y: 290, label: "1", color: "#388E3C" },
    { x: 340, y: 390, label: "2", color: "#F9A825" },
    { x: 340, y: 490, label: "3", color: "#1976D2" },
  ];
  badges.forEach(({ x, y, label, color }) => {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#FFFFFF"; ctx.font = "bold 14px Arial"; ctx.textAlign = "center";
    ctx.fillText(label, x, y + 5);
  });

  // Priority arrow on left
  ctx.strokeStyle = "#DC2626"; ctx.lineWidth = 2; ctx.setLineDash([6, 3]);
  ctx.beginPath(); ctx.moveTo(80, 285); ctx.lineTo(80, 510); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#DC2626";
  ctx.save(); ctx.translate(80, 510); ctx.rotate(Math.PI / 2);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-10, -5); ctx.lineTo(-10, 5); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.save(); ctx.translate(60, 400); ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = "#DC2626"; ctx.font = "bold 12px Arial"; ctx.textAlign = "center";
  ctx.fillText("GRACEFUL DEGRADATION", 0, 0);
  ctx.restore();

  return canvas.toBuffer("image/png");
}

// ── Diagram 3: Deployment Topology ──
function generateDeploymentDiagram() {
  const W = 1100, H = 550;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#FAFAFA"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#0F1B2D"; ctx.fillRect(0, 0, W, 48);
  ctx.fillStyle = "#EE0000"; ctx.fillRect(0, 44, W, 4);
  ctx.fillStyle = "#FFFFFF"; ctx.font = "bold 18px Arial"; ctx.textAlign = "center";
  ctx.fillText("Deployment Topology — Hub + Spoke Namespaces", W / 2, 32);

  // Hub namespace
  ctx.fillStyle = "#FFF3E0";
  rr(ctx, 30, 70, 500, 420, 14); ctx.fill();
  ctx.strokeStyle = "#F57C00"; ctx.lineWidth = 3;
  rr(ctx, 30, 70, 500, 420, 14); ctx.stroke();
  ctx.fillStyle = "#F57C00";
  rr(ctx, 30, 70, 500, 36, 14); ctx.fill();
  ctx.fillRect(30, 88, 500, 18);
  ctx.fillStyle = "#FFFFFF"; ctx.font = "bold 13px Arial"; ctx.textAlign = "center";
  ctx.fillText("Hub Cluster — ns: openshift-tcs-agentic", 280, 94);

  drawBox(ctx, 55, 125, 210, 60, "Console (React+Nginx)", "Service + Route :8080", "#E3F2FD", "#1976D2", "#0D47A1");
  drawBox(ctx, 290, 125, 220, 60, "Control Plane MCP", "MCP_MODE=hub · :3000", "#E8F5E9", "#388E3C", "#1B5E20");
  drawBox(ctx, 55, 210, 210, 60, "Hub Agent (spoke)", "MCP_MODE=spoke", "#E8F5E9", "#388E3C", "#1B5E20");
  drawBox(ctx, 290, 210, 220, 60, "PostgreSQL (PVC)", "StatefulSet · :5432", "#EDE9FE", "#7C3AED", "#4A148C");
  drawBox(ctx, 55, 295, 210, 60, "Redis", "Deployment · :6379", "#FCE4EC", "#C2185B", "#880E4F");
  drawBox(ctx, 290, 295, 220, 60, "ServiceAccount + RBAC", "cluster-admin", "#DBEAFE", "#2563EB", "#1E40AF");

  // Internal arrows
  drawArrow(ctx, 265, 155, 288, 155, "#6B7280", []);
  drawArrow(ctx, 400, 187, 400, 208, "#6B7280", []);
  drawArrow(ctx, 160, 187, 160, 208, "#6B7280", []);

  // Image badge
  ctx.fillStyle = "#F3F4F6";
  rr(ctx, 55, 380, 455, 50, 8); ctx.fill();
  ctx.strokeStyle = "#D1D5DB"; ctx.lineWidth = 1;
  rr(ctx, 55, 380, 455, 50, 8); ctx.stroke();
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px Arial"; ctx.textAlign = "left";
  ctx.fillText("Container Images:", 70, 400);
  ctx.font = "11px Arial"; ctx.fillStyle = "#6B7280";
  ctx.fillText("MCP Server: node:20-alpine (UID 1001, :3000)  |  Console: nginx:1.27-alpine (random UID, :8080)", 70, 418);

  // Spoke namespace
  ctx.fillStyle = "#E8F4FD";
  rr(ctx, 580, 70, 480, 200, 14); ctx.fill();
  ctx.strokeStyle = "#1976D2"; ctx.lineWidth = 3;
  rr(ctx, 580, 70, 480, 200, 14); ctx.stroke();
  ctx.fillStyle = "#1976D2";
  rr(ctx, 580, 70, 480, 36, 14); ctx.fill();
  ctx.fillRect(580, 88, 480, 18);
  ctx.fillStyle = "#FFFFFF"; ctx.font = "bold 13px Arial"; ctx.textAlign = "center";
  ctx.fillText("Each Spoke Cluster — ns: tcs-agentic-system", 820, 94);

  drawBox(ctx, 610, 125, 210, 60, "tcs-agentic-ai", "MCP_MODE=spoke · :3000", "#DBEAFE", "#2563EB", "#1E40AF");
  drawBox(ctx, 840, 125, 190, 60, "SA + ClusterRole", "RBAC (least privilege)", "#D1FAE5", "#22C55E", "#166534");

  ctx.fillStyle = "#F3F4F6";
  rr(ctx, 610, 210, 420, 40, 8); ctx.fill();
  ctx.strokeStyle = "#D1D5DB"; ctx.lineWidth = 1;
  rr(ctx, 610, 210, 420, 40, 8); ctx.stroke();
  ctx.fillStyle = "#6B7280"; ctx.font = "11px Arial"; ctx.textAlign = "left";
  ctx.fillText("Same MCP image, same 45+ tools, full local execution via in-cluster SA token", 625, 234);

  // Spoke → Hub arrow
  drawArrow(ctx, 608, 170, 532, 170, "#2563EB", [6, 4], "register + heartbeat (outbound)");

  // Spoke deploy commands
  ctx.fillStyle = "#FFFFFF";
  rr(ctx, 580, 300, 480, 110, 10); ctx.fill();
  ctx.strokeStyle = "#D1D5DB"; ctx.lineWidth = 1;
  rr(ctx, 580, 300, 480, 110, 10); ctx.stroke();
  ctx.fillStyle = "#1E3A5F"; ctx.font = "bold 12px Arial"; ctx.textAlign = "left";
  ctx.fillText("Deployment Commands", 600, 325);
  ctx.font = "11px Consolas"; ctx.fillStyle = "#2563EB";
  ctx.fillText("# Hub (once):", 600, 350);
  ctx.fillStyle = "#374151"; ctx.fillText("./deploy/dashboard/deploy.sh", 710, 350);
  ctx.fillStyle = "#2563EB"; ctx.fillText("# Each spoke:", 600, 375);
  ctx.fillStyle = "#374151"; ctx.fillText("./deploy/mcp/deploy.sh --cluster-name X --hub-url Y", 710, 375);

  return canvas.toBuffer("image/png");
}

// ── Diagram 4: Agent-on-Every-Cluster Model ──
function generateAgentModelDiagram() {
  const W = 1000, H = 400;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#FAFAFA"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#0F1B2D"; ctx.fillRect(0, 0, W, 48);
  ctx.fillStyle = "#EE0000"; ctx.fillRect(0, 44, W, 4);
  ctx.fillStyle = "#FFFFFF"; ctx.font = "bold 18px Arial"; ctx.textAlign = "center";
  ctx.fillText("Agent on Every Cluster — Same Image, Full Toolset Everywhere", W / 2, 32);

  // Hub
  ctx.fillStyle = "#FFF3E0";
  rr(ctx, 50, 80, 280, 200, 14); ctx.fill();
  ctx.strokeStyle = "#F57C00"; ctx.lineWidth = 3;
  rr(ctx, 50, 80, 280, 200, 14); ctx.stroke();
  ctx.fillStyle = "#F57C00";
  rr(ctx, 50, 80, 280, 32, 14); ctx.fill();
  ctx.fillRect(50, 96, 280, 16);
  ctx.fillStyle = "#FFFFFF"; ctx.font = "bold 13px Arial"; ctx.textAlign = "center";
  ctx.fillText("Hub Cluster", 190, 101);
  drawBox(ctx, 70, 130, 240, 55, "MCP Server + Console + DB", "Full management plane", "#FFF8E1", "#F9A825", "#F57F17");
  ctx.fillStyle = "#E65100"; ctx.font = "11px Arial"; ctx.textAlign = "center";
  ctx.fillText("Orchestration · Fleet registry · LLM gateway", 190, 210);
  ctx.fillText("Credentials store · Cross-cluster correlation", 190, 226);
  ctx.fillText("Same MCP server image as spokes", 190, 248);

  // Spoke
  ctx.fillStyle = "#E8F4FD";
  rr(ctx, 560, 80, 380, 200, 14); ctx.fill();
  ctx.strokeStyle = "#1976D2"; ctx.lineWidth = 3;
  rr(ctx, 560, 80, 380, 200, 14); ctx.stroke();
  ctx.fillStyle = "#1976D2";
  rr(ctx, 560, 80, 380, 32, 14); ctx.fill();
  ctx.fillRect(560, 96, 380, 16);
  ctx.fillStyle = "#FFFFFF"; ctx.font = "bold 13px Arial"; ctx.textAlign = "center";
  ctx.fillText("Spoke Cluster (any)", 750, 101);
  drawBox(ctx, 580, 130, 180, 55, "MCP Server", "Same image, full toolset", "#DBEAFE", "#2563EB", "#1E40AF");
  drawBox(ctx, 780, 130, 140, 55, "ServiceAccount", "In-cluster token", "#D1FAE5", "#22C55E", "#166534");
  ctx.fillStyle = "#0D47A1"; ctx.font = "11px Arial"; ctx.textAlign = "center";
  ctx.fillText("45+ tools · AI Chat · Scans · Fix proposals", 750, 210);
  ctx.fillText("Executes locally with in-cluster SA credentials", 750, 226);
  ctx.fillText("LLM + DB calls relayed through hub", 750, 248);

  // Arrows between
  const arrowData = [
    { y: 130, label: "1  register (outbound)", dash: [6, 4] },
    { y: 160, label: "2  heartbeat 30s (outbound)", dash: [6, 4] },
    { y: 190, label: "3  LLM + DB relay via hub", dash: [6, 4] },
    { y: 220, label: "4  proxy chat / tool requests", dash: [] },
  ];
  arrowData.forEach(({ y, label, dash }, i) => {
    const fromLeft = i < 3;
    const x1 = fromLeft ? 558 : 332;
    const x2 = fromLeft ? 332 : 558;
    const color = fromLeft ? "#2563EB" : "#F57C00";
    drawArrow(ctx, x1, y, x2, y, color, dash, label);
  });

  // Key property
  ctx.fillStyle = "#E8F5E9";
  rr(ctx, 50, 310, 890, 60, 10); ctx.fill();
  ctx.strokeStyle = "#388E3C"; ctx.lineWidth = 2;
  rr(ctx, 50, 310, 890, 60, 10); ctx.stroke();
  ctx.fillStyle = "#1B5E20"; ctx.font = "bold 13px Arial"; ctx.textAlign = "left";
  ctx.fillText("KEY PROPERTY:", 75, 335);
  ctx.font = "12px Arial"; ctx.fillStyle = "#374151";
  ctx.fillText("Because every cluster runs the identical code, AI Chat, fix proposals, and lifecycle cards render identically", 210, 335);
  ctx.fillText("whether you are on the hub or any spoke. Connectivity is outbound-only (no inbound firewall rules needed).", 210, 355);

  return canvas.toBuffer("image/png");
}

// ═══════════════════════════════════════════
// Generate all diagrams
// ═══════════════════════════════════════════
const systemContextPng = generateSystemContextDiagram();
const threeTierPng = generateThreeTierDiagram();
const deploymentPng = generateDeploymentDiagram();
const agentModelPng = generateAgentModelDiagram();

// ═══════════════════════════════════════════
// Build the DOCX
// ═══════════════════════════════════════════
const doc = new Document({
  styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
  sections: [{
    properties: { page: { margin: { top: 1200, bottom: 1200, left: 1200, right: 1200 } } },
    children: [
      // ═══════════════════════════════════════════
      // COVER PAGE
      // ═══════════════════════════════════════════
      new Paragraph({ spacing: { before: 1200 } }),
      new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: [
        new TableCell({
          children: [
            new Paragraph({ spacing: { before: 400 } }),
            new Paragraph({ children: [new TextRun({ text: "TCS Agentic AI", bold: true, size: 56, color: C.white, font: "Calibri" })], alignment: AlignmentType.CENTER, spacing: { after: 80 } }),
            new Paragraph({ children: [new TextRun({ text: "High-Level & Low-Level Design", size: 36, color: "93C5FD", font: "Calibri" })], alignment: AlignmentType.CENTER, spacing: { after: 120 } }),
            new Paragraph({ children: [new TextRun({ text: "──────────────────────────────", size: 20, color: "3B82F6" })], alignment: AlignmentType.CENTER, spacing: { after: 120 } }),
            new Paragraph({ children: [new TextRun({ text: "Agent on Every Cluster — AI-Native Multi-Cluster Platform", size: 28, color: C.white, font: "Calibri", italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 200 } }),
            new Paragraph({ children: [new TextRun({ text: "Architecture: MCP Hub + Spoke with Three-Tier Fabric", size: 22, color: "93C5FD" })], alignment: AlignmentType.CENTER, spacing: { after: 40 } }),
            new Paragraph({ children: [new TextRun({ text: "Date: " + new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }), size: 22, color: "93C5FD" })], alignment: AlignmentType.CENTER, spacing: { after: 40 } }),
            new Paragraph({ children: [new TextRun({ text: "Audience: Architects · Platform Engineers · Reviewers", size: 20, color: "60A5FA", italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 40 } }),
            new Paragraph({ children: [new TextRun({ text: "Classification: Internal — Architecture Document", size: 20, color: "60A5FA", italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 400 } }),
          ],
          shading: { fill: C.navyDark, type: ShadingType.CLEAR },
          borders: noBorders,
          margins: { top: 200, bottom: 200, left: 300, right: 300 },
        }),
      ]})] }),

      // ═══════════════════════════════════════════
      // TABLE OF CONTENTS
      // ═══════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("Table of Contents", 1),
      ...[
        "1. System Overview",
        "2. High-Level Design (HLD)",
        "   2.1 System Context Diagram",
        "   2.2 Logical Layers",
        "   2.3 Agent on Every Cluster Model",
        "3. Component Inventory",
        "   3.1 Frontend (Console)",
        "   3.2 Backend (MCP Server)",
        "   3.3 Data Stores",
        "4. Technology Stack",
        "5. Low-Level Design (LLD)",
        "   5.1 Three-Tier Communication Fabric",
        "   5.2 Request Flow — AI Chat on a Spoke",
        "   5.3 Per-Tool Invocation (invokeOrDirect)",
        "   5.4 Cluster Registration Flows",
        "   5.5 Cross-Cluster Correlation Engine",
        "   5.6 MCP Operational Modes",
        "6. Data Model",
        "7. Deployment Topology",
        "8. Security & Isolation Design",
        "9. Design Decisions & Rationale",
      ].map(t => para(t, { after: 30, size: t.startsWith("  ") ? 20 : 22 })),

      // ═══════════════════════════════════════════
      // 1. SYSTEM OVERVIEW
      // ═══════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("1. System Overview", 1),
      para("TCS Agentic AI lets a single operator manage a fleet of OpenShift/Kubernetes clusters through one console — running AI-driven chat, dashboards, audit, and autonomous remediation identically on every cluster, hub or spoke.", { after: 120 }),
      para("The platform is split into two planes and runs the same MCP server image on every cluster (the only difference is one environment variable, MCP_MODE):", { after: 120 }),
      dataTable(
        ["Plane", "Where", "What Runs"],
        [
          ["Management Plane", "Hub cluster, deployed once", "React console + Control Plane MCP server + PostgreSQL + Redis"],
          ["Data Plane", "Every cluster (including hub)", "One stateless MCP server pod (MCP_MODE=spoke) with the full toolset, executing live against its own cluster"],
        ],
        [18, 25, 57],
        { headerColor: C.blue }
      ),
      para(""),
      archBox(
        "KEY PROPERTY",
        null,
        [
          { icon: "▶", label: "Same image everywhere", detail: "— one artifact to build, scan, and ship" },
          { icon: "▶", label: "Identical capabilities", detail: "— AI Chat, fix proposals, lifecycle cards render identically on hub and spokes" },
          { icon: "▶", label: "Differentiated by MCP_MODE env var only", detail: "— hub / spoke / control / standalone" },
        ],
        { bg: C.greenLight, border: C.green, titleColor: C.green }
      ),

      // ═══════════════════════════════════════════
      // 2. HIGH-LEVEL DESIGN
      // ═══════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("2. High-Level Design (HLD)", 1),

      heading("2.1 System Context Diagram", 2),
      para("The system context shows how the platform operator interacts with the Hub, which manages a fleet of spoke clusters via the three-tier communication fabric.", { after: 120 }),
      new Paragraph({
        children: [new ImageRun({ data: systemContextPng, transformation: { width: 700, height: 408 }, type: "png" })],
        alignment: AlignmentType.CENTER, spacing: { after: 80 },
      }),
      para("Figure 1: System Context — Hub Management Plane + Spoke Data Plane + External Services", { italic: true, color: C.gray, align: AlignmentType.CENTER, after: 200 }),

      heading("2.2 Logical Layers", 2),
      para("The architecture is organized into five logical layers:", { after: 100 }),
      dataTable(
        ["Layer", "Components", "Responsibility"],
        [
          ["Presentation", "Views (Dashboard, AI Chat, Audit, AI Intelligence), Zustand stores, TanStack Query", "User interface, state management, cluster-keyed data fetching"],
          ["API", "Universal Request Router (src/index.js), Auth & RBAC, Cluster-Context Router", "HTTP handling, authentication, per-request cluster routing via AsyncLocalStorage"],
          ["Services", "Chat / NLU / Reasoning, Orchestrators, Intelligence, 45+ MCP Tools", "Business logic — AI reasoning, multi-step workflows, tool execution"],
          ["Communication", "Spoke Proxy, Direct Access, Agent Bridge (SSE)", "Three-tier fabric connecting hub to every spoke cluster"],
          ["Persistence", "PostgreSQL, Redis, In-memory registries", "Durable state, caching, fast lookups"],
        ],
        [15, 38, 47]
      ),

      heading("2.3 Agent on Every Cluster Model", 2),
      para("Every cluster is a full peer: it runs the complete MCP server with all 45+ tools and executes scans, log reads, metrics, and AI reasoning locally. The hub is simply the peer that also hosts the console, database, and fleet-wide orchestration.", { after: 120 }),
      new Paragraph({
        children: [new ImageRun({ data: agentModelPng, transformation: { width: 660, height: 264 }, type: "png" })],
        alignment: AlignmentType.CENTER, spacing: { after: 80 },
      }),
      para("Figure 2: Agent on Every Cluster — Same Image, Full Toolset, Outbound-Only Connectivity", { italic: true, color: C.gray, align: AlignmentType.CENTER, after: 200 }),
      bulletPara("Connectivity is outbound-only — spokes dial the hub, no inbound firewall rules needed on managed clusters"),
      bulletPara("LLM API keys + DB credentials stay on the hub — spokes relay through /api/llm/relay and /api/db/query"),
      bulletPara("A spoke failure affects only that cluster; hub and other spokes keep working"),

      // ═══════════════════════════════════════════
      // 3. COMPONENT INVENTORY
      // ═══════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("3. Component Inventory", 1),

      heading("3.1 Frontend (Console)", 2),
      para("Location: console/ — built with Vite, served by Nginx (console/Dockerfile).", { after: 100 }),
      dataTable(
        ["Component", "Files", "Responsibility"],
        [
          ["App Shell", "src/App.jsx, src/main.jsx", "Header, 4-tab nav, back pill, brand, routing"],
          ["Views", "src/views/*.jsx", "Dashboard, AI Chat, Audit, AI Intelligence, AI Hub, Cluster Picker"],
          ["Widgets", "src/components/widgets/*.jsx", "19 dashboard widgets (health, nodes, pods, operators, alerts, risk, capacity, topology, heatmap, etc.)"],
          ["Components", "src/components/*.jsx", "Login overlay, Settings panel, Agent registry, Command palette, Toast stack, User mgmt"],
          ["State Stores", "src/store/*.js", "Zustand: authStore, clusterStore, chatStore, themeStore, toastStore, viewStore, healthHistoryStore"],
          ["Data Layer", "src/hooks/useClusterQuery.js, src/api/client.js", "TanStack Query wrapper — keys every query to active cluster; API client injects cluster context"],
          ["Design System", "src/design/", "Shared tokens + components: StatusDot, SeverityBadge, ExpandableSection, ConfirmDialog, ActionCard, ProgressTimeline"],
        ],
        [16, 32, 52],
        { headerColor: C.blue }
      ),
      para(""),
      para("The 4 primary tabs (per CLAUDE.md design contract):", { bold: true, after: 80 }),
      dataTable(
        ["Tab", "View", "Highlights"],
        [
          ["Dashboard", "DashboardView.jsx", "16+ live widgets"],
          ["AI Chat", "ChatView.jsx + ChatTokens.jsx", "Conversation, fix proposals, ServiceNow & upgrade cards"],
          ["Audit", "AuditView.jsx", "Compliance trail, CIS scoring, change requests"],
          ["AI Intelligence", "IntelligenceView.jsx", "Risk predictions, anomaly detection, knowledge base, cross-cluster correlation"],
        ],
        [15, 28, 57],
        { headerColor: C.purple }
      ),

      heading("3.2 Backend (MCP Server)", 2),
      para("Location: src/ — Node.js 20 ESM, no web framework (raw http server). Entry point: src/index.js (~6,500 lines).", { after: 100 }),
      dataTable(
        ["Module Group", "Location", "Responsibility"],
        [
          ["Entry / Router", "src/index.js", "HTTP server, universal request routing, cluster-context resolution, all REST endpoints"],
          ["Chat & AI", "src/services/chat-api.js (~17k lines), nlu*.js, reasoning.js, task-planner.js", "NLU, tool selection, agentic loop, rich-card responses"],
          ["Orchestrators", "src/services/upgrade-orchestrator.js, deployment-orchestrator.js, action-workflow.js", "Multi-step workflows with cluster-context wrapping"],
          ["Communication Fabric", "src/services/spoke-proxy.js, agent-bridge.js, cluster-credentials.js, openshift-client.js", "The three tiers (Spoke Proxy, Direct Access, Agent Bridge)"],
          ["Intelligence", "src/services/cross-cluster-correlation.js, predictive-intel.js, proactive-agent.js, incident-rag.js", "Multi-cluster correlation, predictions, RAG, learning"],
          ["Tools", "src/tools/*.js (45+ files)", "Cluster, pods, nodes, security, compliance, GitOps, Velero, KubeVirt, network, etc."],
          ["Platform", "src/platform/*.js", "Distro detection, K8s client, intent router, provider adapters"],
          ["Integrations", "src/services/integrations.js, notifications.js, chatops.js", "ServiceNow, Slack, Teams, PagerDuty, Ansible, webhooks"],
          ["Persistence", "src/utils/db.js, cache.js, state-store.js", "PostgreSQL pool, Redis cache, state abstraction"],
          ["Security", "src/security/command-validator.js, guardrails.js, safety.js, redaction.js, auth.js", "Command validation, guardrails, secret redaction, auth/RBAC"],
        ],
        [18, 35, 47],
        { headerColor: C.green }
      ),

      heading("3.3 Data Stores", 2),
      dataTable(
        ["Store", "Type", "Holds"],
        [
          ["PostgreSQL", "Persistent (StatefulSet PVC)", "Settings, chat history, audit log, change requests, incidents, knowledge base, cluster_credentials, cluster_snapshots, silenced_alerts"],
          ["Redis", "Cache", "Sessions, hot dashboard data, rate-limit counters"],
          ["In-memory registries", "Process memory (rebuilt from DB on boot)", "_connectedAgents, _spokes, _channels (SSE), credential cache"],
        ],
        [18, 25, 57],
        { headerColor: C.purple }
      ),

      // ═══════════════════════════════════════════
      // 4. TECHNOLOGY STACK
      // ═══════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("4. Technology Stack", 1),

      heading("4.1 Frontend", 2),
      dataTable(
        ["Concern", "Technology", "Version"],
        [
          ["UI Framework", "React", "18.3"],
          ["Build Tool", "Vite", "6.0"],
          ["Server State", "TanStack Query", "5.62"],
          ["Client State", "Zustand", "5.0"],
          ["Runtime Serving", "Nginx (Alpine)", "1.27"],
          ["Typography", "Inter (UI), SF Mono / Fira Code (code)", "—"],
        ],
        [30, 40, 30],
        { headerColor: C.blue }
      ),
      para(""),
      heading("4.2 Backend", 2),
      dataTable(
        ["Concern", "Technology", "Version"],
        [
          ["Runtime", "Node.js (ESM)", "≥ 20"],
          ["HTTP Layer", "Native http (no framework)", "—"],
          ["MCP", "@modelcontextprotocol/sdk", "1.12"],
          ["K8s Client", "@kubernetes/client-node", "1.4"],
          ["Database", "PostgreSQL via pg", "8.13"],
          ["Cache", "Redis via ioredis", "5.4"],
          ["HTTP Client", "undici", "6.21"],
          ["Validation", "zod", "3.24"],
          ["YAML / Docs", "js-yaml, docx, mammoth", "—"],
          ["Container", "node:20-alpine, non-root UID 1001", "—"],
        ],
        [30, 40, 30],
        { headerColor: C.green }
      ),

      // ═══════════════════════════════════════════
      // 5. LOW-LEVEL DESIGN
      // ═══════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("5. Low-Level Design (LLD)", 1),

      heading("5.1 Three-Tier Communication Fabric", 2),
      para("The hub reaches every remote cluster through a priority waterfall. Tier 1 (full spoke agent) is the intended steady state; Tiers 2–3 are graceful degradation paths.", { after: 120 }),
      new Paragraph({
        children: [new ImageRun({ data: threeTierPng, transformation: { width: 700, height: 382 }, type: "png" })],
        alignment: AlignmentType.CENTER, spacing: { after: 80 },
      }),
      para("Figure 3: Three-Tier Communication Fabric — Priority Waterfall with Graceful Degradation", { italic: true, color: C.gray, align: AlignmentType.CENTER, after: 150 }),
      dataTable(
        ["Tier", "Mechanism", "Module", "When It's Used"],
        [
          ["1 — Spoke Proxy", "HTTP relay to spoke's MCP server", "spoke-proxy.js (hasSpoke, proxyToSpoke)", "Cluster runs a full MCP agent pod (primary state)"],
          ["2 — Direct Access", "Hub calls K8s API with stored apiUrl + token", "cluster-credentials.js, openshift-client.js", "Cluster registered via dashboard, agent not yet deployed"],
          ["3 — Agent Bridge", "SSE reverse tunnel for tool requests", "agent-bridge.js (hasActiveChannel, invokeAgentTool)", "Spoke behind NAT, cannot expose an HTTP URL"],
        ],
        [15, 25, 30, 30],
        { headerColor: C.orange }
      ),
      para(""),
      para("Routing context is set per-request via AsyncLocalStorage in openshift-client.js, so every downstream ocpGet/ocpFetch automatically targets the right cluster without threading parameters through every function.", { after: 120 }),

      heading("5.2 Request Flow — AI Chat on a Spoke", 2),
      para("The following sequence shows how a user query on a spoke cluster flows through the system:", { after: 100 }),
      archBox(
        "Chat Request Sequence: \"Show pods on prod-east\"",
        "End-to-end flow through hub proxy to spoke execution",
        [
          { icon: "①", label: "User types query in Console", detail: "" },
          { icon: "②", label: "Console → POST /api/chat?cluster=prod-east → Hub MCP", detail: "" },
          { icon: "③", label: "Hub performs self-identity check (CLUSTER_NAME vs cluster)", detail: "" },
          { icon: "④", label: "Hub: hasSpoke(prod-east)? → yes → proxyChatToSpoke()", detail: "" },
          { icon: "⑤", label: "Spoke runs full toolset locally (in-cluster SA token)", detail: "" },
          { icon: "⑥", label: "Spoke → invokeOrDirect → get_pods (live K8s API call)", detail: "" },
          { icon: "⑦", label: "Spoke → LLM reasoning (relayed via hub) → structured response", detail: "" },
          { icon: "⑧", label: "Hub returns identical rich JSON (cards, fix proposals) → Console renders", detail: "" },
        ],
        { bg: C.blueLight, border: C.blue }
      ),

      heading("5.3 Per-Tool Invocation (invokeOrDirect)", 2),
      para("When the spoke is unavailable and the cluster is reached via Tier 2 or 3, chat tools resolve through invokeOrDirect() in chat-api.js:", { after: 100 }),
      dataTable(
        ["Condition", "Action", "Example"],
        [
          ["hasActiveChannel(X)?", "invokeAgentTool over SSE", "Tool call relayed through reverse SSE tunnel"],
          ["hasCredentials(X)?", "withClusterDirect → K8s REST call", "get_pods → GET /api/v1/namespaces/NS/pods"],
          ["Neither available", "Return null → fall back to cached data", "Serve last known cluster_snapshots from DB"],
        ],
        [25, 35, 40],
        { headerColor: C.teal }
      ),
      para(""),
      para("Direct-access tool mapping:", { bold: true, after: 80 }),
      codeBlock([
        "get_pods     → GET /api/v1/namespaces/{ns}/pods",
        "get_logs     → GET /api/v1/namespaces/{ns}/pods/{name}/log",
        "list_resources → GET /apis/{apiGroup}/{version}/{kind}",
        "describe     → Full GET + field extraction",
      ], C.teal),

      heading("5.4 Cluster Registration Flows", 2),
      para("Two paths to register a cluster:", { after: 100 }),
      archBox(
        "Path A — Dashboard Direct Registration",
        "User enters name + apiUrl + token/kubeconfig via ConnectClusterModal",
        [
          { icon: "①", label: "POST /api/hub/clusters", detail: "— user submits cluster credentials" },
          { icon: "②", label: "Connectivity test: GET /api/v1/namespaces?limit=1", detail: "" },
          { icon: "③", label: "Store in cluster_credentials DB + _connectedAgents", detail: "" },
          { icon: "④", label: "Generate agent YAML for full upgrade (deploy to become Tier 1)", detail: "" },
        ],
        { bg: C.orangeLight, border: C.orange, titleColor: "#E65100" }
      ),
      para(""),
      archBox(
        "Path B — Spoke Self-Registration (full agent)",
        "Agent pod boots with MCP_MODE=spoke and self-registers to hub",
        [
          { icon: "①", label: "POST /api/spoke/register { clusterName, spokeUrl }", detail: "" },
          { icon: "②", label: "registerSpoke → _spokes + _connectedAgents", detail: "" },
          { icon: "③", label: "Heartbeat every 30s → POST /api/spoke/heartbeat", detail: "" },
          { icon: "④", label: "Receives LLM relay config back from hub", detail: "" },
        ],
        { bg: C.greenLight, border: C.green, titleColor: "#1B5E20" }
      ),
      para(""),
      para("Registration endpoints:", { bold: true, after: 80 }),
      dataTable(
        ["Endpoint", "Method", "Purpose"],
        [
          ["/api/hub/clusters", "POST", "Dashboard registration → stores credentials, tests connectivity"],
          ["/api/spoke/register", "POST", "Spoke self-registers its HTTP URL"],
          ["/api/spoke/heartbeat", "POST", "30s liveness + version; self-heals registry after restart"],
          ["/api/agent/report", "POST", "Agent pushes periodic cluster snapshot"],
          ["/api/agent/channel", "GET (SSE)", "Opens the Tier-3 reverse tunnel"],
          ["DELETE /api/agent/:name", "DELETE", "Removes cluster from all registries (agents, spoke, credentials, snapshot)"],
        ],
        [30, 15, 55],
        { headerColor: C.green }
      ),

      heading("5.5 Cross-Cluster Correlation Engine", 2),
      para("src/services/cross-cluster-correlation.js detects incidents that span clusters — something no single-cluster tool can see.", { after: 100 }),
      para("Signal Sources:", { bold: true, after: 60 }),
      bulletPara("Cluster snapshots DB (pods, operators, nodes, events)"),
      bulletPara("Live proactive insights (in-memory anomalies)"),
      bulletPara("incident_history DB (last 1 hour)"),
      para(""),
      para("Scoring rules:", { bold: true, after: 60 }),
      dataTable(
        ["Rule", "Score Boost", "Description"],
        [
          ["Same issue type", "+50", "Both clusters have the same issue category"],
          ["Similar symptoms", "+30", "Symptoms text partially matches"],
          ["Same operator", "+40", "Identical operator affected across clusters"],
          ["Same namespace", "+20", "Issue in same logical namespace"],
          ["Within 10 minutes", "+30", "Strong temporal correlation"],
          ["Within 30 minutes", "+10", "Moderate temporal correlation"],
        ],
        [25, 15, 60],
        { headerColor: C.orange }
      ),
      para(""),
      para("A pair scoring ≥50 forms a correlation group. The \"Investigate\" button triggers on-demand LLM root-cause analysis across the correlated clusters.", { after: 80 }),
      para("Example: CrashLoopBackOff on prod-east at 10:02 + same image failing on staging-west at 10:04 → surfaced as one correlated incident (\"likely bad image push\").", { italic: true, color: C.gray }),

      heading("5.6 MCP Operational Modes", 2),
      para("A single MCP server image supports four operational modes, controlled by one environment variable:", { after: 100 }),
      dataTable(
        ["Mode", "Role", "Behavior"],
        [
          ["hub (default)", "Central management", "Receives registrations, proxies, runs orchestrators, serves console"],
          ["spoke", "Remote full agent", "Registers to hub, serves data-plane locally, relays LLM/DB through hub"],
          ["control", "Stateless control plane", "No direct K8s access — requires agent pods for all cluster data"],
          ["standalone", "Single cluster", "No federation; everything local"],
        ],
        [18, 22, 60],
        { headerColor: C.purple }
      ),

      // ═══════════════════════════════════════════
      // 6. DATA MODEL
      // ═══════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("6. Data Model", 1),

      heading("6.1 Key PostgreSQL Tables", 2),
      dataTable(
        ["Table", "Purpose", "Notable Columns"],
        [
          ["cluster_credentials", "Tier-2 direct-access creds", "cluster_name (PK), api_url, token, platform, display_name, updated_at"],
          ["cluster_snapshots", "Latest report per cluster (warm boot)", "cluster, report (JSON), reported_at"],
          ["incident_history", "Historical incidents for correlation/RAG", "cluster, issue_type, issue_signature, resource_name, namespace, severity, occurred_at"],
          ["silenced_alerts", "Per-cluster alert silences", "name, namespace, cluster, silenced_at, expires_at"],
          ["settings, chats, audit, CRs, KB", "Platform state", "Per-feature schemas"],
        ],
        [20, 28, 52],
        { headerColor: C.purple }
      ),

      heading("6.2 In-Memory Registries", 2),
      para("Rebuilt from PostgreSQL on boot:", { after: 80 }),
      dataTable(
        ["Registry", "Structure", "Keyed By", "Used For"],
        [
          ["_connectedAgents", "Map", "cluster name", "Cluster cards + latest report snapshot"],
          ["_spokes", "Map", "cluster name", "Tier-1 HTTP proxy URL + health"],
          ["_channels", "Map", "cluster name", "Tier-3 SSE response + tool registry + pending requests"],
          ["credential cache", "Map", "cluster name (lowercase)", "Fast Tier-2 lookups"],
        ],
        [22, 12, 22, 44]
      ),

      heading("6.3 Connection-Type Derivation", 2),
      para("The cluster card badge shows how the hub currently reaches a cluster:", { after: 80 }),
      codeBlock([
        "connectionType = hasCredentials(cluster)  ? \"direct\"",
        "               : hasActiveChannel(cluster) ? \"agent\"",
        "               : \"spoke\"",
      ], C.blue),

      // ═══════════════════════════════════════════
      // 7. DEPLOYMENT TOPOLOGY
      // ═══════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("7. Deployment Topology", 1),
      new Paragraph({
        children: [new ImageRun({ data: deploymentPng, transformation: { width: 700, height: 350 }, type: "png" })],
        alignment: AlignmentType.CENTER, spacing: { after: 80 },
      }),
      para("Figure 4: Deployment Topology — Hub and Spoke Kubernetes Namespaces", { italic: true, color: C.gray, align: AlignmentType.CENTER, after: 150 }),

      para("Deployment commands:", { bold: true, after: 80 }),
      dataTable(
        ["Step", "Command", "Runs"],
        [
          ["Management bundle (once)", "./deploy/dashboard/deploy.sh", "Console + Control Plane + PostgreSQL + Redis"],
          ["Cluster agent (every cluster)", "./deploy/mcp/deploy.sh --cluster-name <name> --hub-url <url>", "One stateless MCP spoke pod"],
        ],
        [25, 40, 35]
      ),
      para(""),
      para("Container images:", { bold: true, after: 80 }),
      dataTable(
        ["Image", "Base", "User", "Port"],
        [
          ["MCP Server", "node:20-alpine", "non-root UID 1001", "3000"],
          ["Console", "nginx:1.27-alpine", "random OpenShift UID (writes to /tmp)", "8080"],
        ],
        [20, 25, 35, 20],
        { headerColor: C.teal }
      ),

      // ═══════════════════════════════════════════
      // 8. SECURITY
      // ═══════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("8. Security & Isolation Design", 1),
      dataTable(
        ["Concern", "Design"],
        [
          ["Connectivity", "Outbound-only from spokes → hub. No inbound firewall holes on managed clusters."],
          ["Credential Isolation", "LLM API keys + DB credentials stay on the hub. Spokes relay LLM/DB calls through /api/llm/relay and /api/db/query. No secrets leave the hub."],
          ["In-cluster Auth", "Each spoke uses its own ServiceAccount token (in-cluster) scoped by a least-privilege ClusterRole generated per platform."],
          ["Blast-radius Containment", "A spoke failure affects only that cluster; hub and other spokes keep working."],
          ["Command Validation", "src/security/command-validator.js + guardrails.js + safety.js validate/guard every mutating action."],
          ["Secret Redaction", "redaction.js scrubs secrets from logs and LLM prompts."],
          ["AuthN/AuthZ", "auth.js — password + token login (LoginOverlay), RBAC in Settings."],
          ["Per-cluster Isolation", "Frontend keys all queries + chat state to the active cluster (useClusterQuery, chatStore); backend scopes via ?cluster= + X-Cluster-Context."],
          ["Self-healing", "Heartbeats re-register spokes after hub or spoke restarts; registries rebuild from PostgreSQL on boot."],
        ],
        [22, 78],
        { headerColor: C.red }
      ),

      // ═══════════════════════════════════════════
      // 9. DESIGN DECISIONS
      // ═══════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading("9. Design Decisions & Rationale", 1),
      dataTable(
        ["#", "Decision", "Rationale"],
        [
          ["1", "Same image on every cluster (MCP_MODE switch)", "Guarantees identical capabilities and identical UI on hub and all spokes; one artifact to build, scan, and ship."],
          ["2", "Three-tier waterfall (proxy → direct → bridge)", "Full-agent spokes are ideal, but the platform still delivers value the instant a cluster is registered with just a token (Tier 2) and works through NAT (Tier 3)."],
          ["3", "Outbound-only registration", "Matches ArgoCD / RHACM / Rancher; avoids inbound firewall changes — the #1 enterprise onboarding blocker."],
          ["4", "AsyncLocalStorage for cluster context", "Per-request routing without threading a cluster param through thousands of lines; downstream ocpFetch \"just works.\""],
          ["5", "Credentials + snapshots in PostgreSQL", "Warm boot (dashboards have data immediately), survives hub restarts, single source of truth rebuilt into in-memory registries."],
          ["6", "LLM/DB relay through hub", "Keeps all secrets centralized; spokes never hold API keys or DB credentials."],
          ["7", "Cross-cluster correlation", "A differentiator no single-cluster tool offers — turns fleet-wide noise into one root-caused incident."],
          ["8", "Raw Node http (no framework)", "Minimal dependency surface, smaller image, full control over the universal router and SSE channels."],
        ],
        [5, 30, 65],
        { headerColor: C.navy }
      ),

      // ═══════════════════════════════════════════
      // FOOTER
      // ═══════════════════════════════════════════
      new Paragraph({ spacing: { before: 600 } }),
      new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: [
        new TableCell({
          children: [
            new Paragraph({ children: [new TextRun({ text: "— End of Document —", size: 20, color: C.white, italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 20 } }),
            new Paragraph({ children: [new TextRun({ text: "TCS Agentic AI — HLD/LLD Architecture Document", size: 18, color: "93C5FD" })], alignment: AlignmentType.CENTER, spacing: { after: 10 } }),
            new Paragraph({ children: [new TextRun({ text: "Generated by TCS Agentic AI Platform", size: 16, color: "60A5FA" })], alignment: AlignmentType.CENTER, spacing: { after: 0 } }),
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
const outPath = "docs/TCS-Agentic-AI-HLD-LLD-Design.docx";
await writeFile(outPath, buffer);
console.log("Created: " + outPath + " (" + buffer.length + " bytes)");
