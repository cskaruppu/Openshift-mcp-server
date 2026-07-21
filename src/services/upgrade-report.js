/**
 * Upgrade Report Generator — Professional PDF reports for OpenShift cluster upgrades.
 *
 * Generates two report types:
 *   1. Pre-Assessment Report  — before upgrade execution
 *   2. Post-Assessment Report — after upgrade completion
 *
 * Uses pdfkit to produce A4 PDF documents with tables, colored status badges,
 * and the TCS Agentic AI branding.
 */

import PDFDocument from "pdfkit";

// ═══════════════════════════════════════════
// Color palette (matches TCS design system)
// ═══════════════════════════════════════════

const C = {
  navyDark: "0F1B2D",
  navy: "1e3a5f",
  blue: "2563eb",
  blueBg: "DBEAFE",
  green: "15803d",
  greenBg: "D1FAE5",
  orange: "C2410C",
  orangeBg: "FED7AA",
  red: "DC2626",
  redBg: "FEE2E2",
  gray: "6B7280",
  grayLight: "F9FAFB",
  grayBorder: "E5E7EB",
  white: "FFFFFF",
  black: "111827",
};

// ═══════════════════════════════════════════
// Status color helper
// ═══════════════════════════════════════════

/**
 * Returns the appropriate color code for a status string.
 * @param {string} status - Status label (e.g. "READY", "pass", "warn", "fail")
 * @returns {{ text: string, bg: string }} Color pair for text and background
 */
export function getStatusColor(status) {
  const s = (status || "").toLowerCase().trim();
  if (s === "ready" || s === "pass" || s === "passed" || s === "success" || s === "resolved") {
    return { text: C.green, bg: C.greenBg };
  }
  if (s === "ready_with_warnings" || s === "warn" || s === "warning" || s === "persistent") {
    return { text: C.orange, bg: C.orangeBg };
  }
  if (s === "not_ready" || s === "fail" || s === "failed" || s === "new" || s === "critical") {
    return { text: C.red, bg: C.redBg };
  }
  return { text: C.gray, bg: C.grayLight };
}

// ═══════════════════════════════════════════
// Utility helpers
// ═══════════════════════════════════════════

/**
 * Formats a date for display in the report.
 */
function formatDate(date) {
  try {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  }
}

/**
 * Formats a timestamp for timeline display.
 */
function formatTimestamp(ts) {
  try {
    const d = ts instanceof Date ? ts : new Date(ts);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(ts || "N/A");
  }
}

/**
 * Safe accessor — returns fallback for nullish/undefined values.
 */
function safe(val, fallback = "N/A") {
  if (val === null || val === undefined || val === "") return fallback;
  return String(val);
}

/**
 * Build status badge color for cover pages.
 */
function overallBadge(overall) {
  const s = (overall || "").toUpperCase();
  if (s === "READY" || s === "SUCCESS" || s === "PASS") return { text: "READY", color: "22C55E" };
  if (s === "READY_WITH_WARNINGS") return { text: "READY WITH WARNINGS", color: "F59E0B" };
  if (s === "NOT_READY" || s === "FAILED" || s === "FAIL") return { text: "NOT READY", color: "EF4444" };
  return { text: s || "UNKNOWN", color: C.gray };
}

// ═══════════════════════════════════════════
// PDF Table helper
// ═══════════════════════════════════════════

/**
 * Measures the height needed for a cell's text to fit within a given width.
 * @param {PDFDocument} doc
 * @param {string} text
 * @param {number} width - Available cell width (excluding padding)
 * @param {number} fontSize
 * @returns {number} Required cell height in points
 */
function measureCellHeight(doc, text, width, fontSize) {
  doc.save();
  doc.font("Helvetica").fontSize(fontSize);
  const h = doc.heightOfString(String(text || ""), { width: width - 8 });
  doc.restore();
  return Math.max(h + 12, 22); // minimum 22px
}

/**
 * Draws a table on the PDF document with auto-sizing row heights.
 *
 * Each cell in `rows` can be either a plain string or an object:
 *   { text, bg, color, bold, mono }
 *
 * @param {PDFDocument} doc
 * @param {string[]} headers
 * @param {Array<Array<string|object>>} rows
 * @param {object} opts
 */
function drawTable(doc, headers, rows, opts = {}) {
  const startX = opts.x || 50;
  let startY = opts.y || doc.y;
  const colWidths = opts.colWidths || headers.map(() => (doc.page.width - 100) / headers.length);
  const headerBg = opts.headerBg || "#" + C.navy;
  const fontSize = opts.fontSize || 9;

  let y = startY;

  // Measure header row height
  const headerRowHeight = Math.max(...headers.map((h, i) =>
    measureCellHeight(doc, h, colWidths[i], fontSize)
  ));

  // Header row — check for page break first
  if (y + headerRowHeight > doc.page.height - 60) {
    doc.addPage();
    y = 50;
  }

  let x = startX;
  doc.save();
  for (let i = 0; i < headers.length; i++) {
    doc.rect(x, y, colWidths[i], headerRowHeight).fill(headerBg);
    doc.fillColor("#FFFFFF").fontSize(fontSize).font("Helvetica-Bold")
      .text(headers[i], x + 4, y + 6, { width: colWidths[i] - 8 });
    x += colWidths[i];
  }
  doc.restore();
  y += headerRowHeight;

  // Data rows
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    x = startX;
    const bgColor = ri % 2 === 1 ? "#" + C.grayLight : "#FFFFFF";

    // Auto-calculate row height based on content
    const rowHeight = Math.max(...row.map((cell, ci) => {
      const cellText = (typeof cell === "object" && cell !== null) ? String(cell.text || "") : String(cell || "");
      return measureCellHeight(doc, cellText, colWidths[ci], fontSize);
    }));

    // Check if we need a new page
    if (y + rowHeight > doc.page.height - 60) {
      doc.addPage();
      y = 50;
    }

    for (let ci = 0; ci < row.length; ci++) {
      const cell = row[ci];
      const cellBg = (typeof cell === "object" && cell !== null && cell.bg) ? cell.bg : bgColor;
      const cellColor = (typeof cell === "object" && cell !== null && cell.color) ? cell.color : "#" + C.black;
      const cellText = (typeof cell === "object" && cell !== null) ? String(cell.text || "") : String(cell || "");
      const cellBold = (typeof cell === "object" && cell !== null && cell.bold);
      const cellFont = (typeof cell === "object" && cell !== null && cell.mono)
        ? "Courier"
        : (cellBold ? "Helvetica-Bold" : "Helvetica");

      doc.save();
      doc.rect(x, y, colWidths[ci], rowHeight).fill(cellBg);
      doc.rect(x, y, colWidths[ci], rowHeight).stroke("#" + C.grayBorder);
      doc.fillColor(cellColor).fontSize(fontSize).font(cellFont)
        .text(cellText, x + 4, y + 6, { width: colWidths[ci] - 8 });
      doc.restore();
      x += colWidths[ci];
    }
    y += rowHeight;
  }

  doc.y = y + 10;
  return y;
}

/**
 * Draws a key-value parameter table.
 */
function drawKVTable(doc, rows, opts = {}) {
  const headers = ["Parameter", "Value"];
  const data = rows.map(([k, v]) => [{ text: k, bold: true }, v]);
  return drawTable(doc, headers, data, { colWidths: [180, doc.page.width - 280], ...opts });
}

// ═══════════════════════════════════════════
// PDF section helpers
// ═══════════════════════════════════════════

/**
 * Draws a section heading (e.g. "1. Executive Summary").
 */
function drawHeading(doc, text, level) {
  const sizeMap = { 1: 18, 2: 15, 3: 13 };
  const size = sizeMap[level] || 18;

  ensureSpace(doc, size + 30);

  doc.font("Helvetica-Bold")
    .fontSize(size)
    .fillColor("#" + C.navy)
    .text(text, 50, doc.y, { width: doc.page.width - 100 });
  doc.moveDown(0.5);
}

/**
 * Draws a paragraph of body text.
 */
function drawParagraph(doc, text, opts = {}) {
  const color = opts.color ? "#" + opts.color : "#" + C.black;
  const font = opts.italic ? "Helvetica-Oblique" : (opts.bold ? "Helvetica-Bold" : "Helvetica");
  const fontSize = opts.fontSize || 10;

  ensureSpace(doc, fontSize + 10);

  doc.font(font)
    .fontSize(fontSize)
    .fillColor(color)
    .text(text, 50, doc.y, { width: doc.page.width - 100 });
  doc.moveDown(0.4);
}

/**
 * Draws a bullet item.
 */
function drawBullet(doc, text, opts = {}) {
  const color = opts.color ? "#" + opts.color : "#" + C.black;
  const fontSize = opts.fontSize || 10;

  ensureSpace(doc, fontSize + 10);

  const bulletChar = "•";
  doc.font("Helvetica")
    .fontSize(fontSize)
    .fillColor(color)
    .text(bulletChar + "  " + text, 60, doc.y, { width: doc.page.width - 120, indent: 10 });
  doc.moveDown(0.2);
}

/**
 * Ensures there is at least `needed` vertical points left on the page.
 * If not, adds a new page.
 */
function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - 60) {
    doc.addPage();
  }
}

// ═══════════════════════════════════════════
// Cover page builder
// ═══════════════════════════════════════════

function drawCoverPage(doc, { title, subtitle, cluster, versionRange, date, classification, badgeText, badgeColor }) {
  const pw = doc.page.width;
  const ph = doc.page.height;
  const ml = doc.page.margins.left;
  const mt = doc.page.margins.top;
  const mr = doc.page.margins.right;
  const mb = doc.page.margins.bottom;

  // Navy dark background covering the entire page area
  doc.save();
  doc.rect(0, 0, pw, ph).fill("#" + C.navyDark);
  doc.restore();

  let y = ph * 0.20;

  // "TCS Agentic AI"
  doc.save();
  doc.font("Helvetica-Bold").fontSize(28).fillColor("#FFFFFF");
  doc.text("TCS Agentic AI", 0, y, { width: pw, align: "center" });
  doc.restore();
  y += 50;

  // Title (light blue)
  doc.save();
  doc.font("Helvetica").fontSize(18).fillColor("#93C5FD");
  doc.text(title, 0, y, { width: pw, align: "center" });
  doc.restore();
  y += 35;

  // Horizontal line
  doc.save();
  doc.strokeColor("#3B82F6").lineWidth(1);
  doc.moveTo(pw * 0.25, y).lineTo(pw * 0.75, y).stroke();
  doc.restore();
  y += 20;

  // Version range (subtitle)
  if (subtitle) {
    doc.save();
    doc.font("Helvetica-Oblique").fontSize(14).fillColor("#FFFFFF");
    doc.text(subtitle, 0, y, { width: pw, align: "center" });
    doc.restore();
    y += 28;
  }

  // Cluster name
  if (cluster) {
    doc.save();
    doc.font("Helvetica").fontSize(12).fillColor("#93C5FD");
    doc.text("Cluster: " + cluster, 0, y, { width: pw, align: "center" });
    doc.restore();
    y += 22;
  }

  // Version range line
  if (versionRange) {
    doc.save();
    doc.font("Helvetica").fontSize(12).fillColor("#93C5FD");
    doc.text(versionRange, 0, y, { width: pw, align: "center" });
    doc.restore();
    y += 30;
  }

  // Status badge
  if (badgeText) {
    const bColor = badgeColor ? "#" + badgeColor : "#" + C.blue;
    doc.save();
    doc.font("Helvetica-Bold").fontSize(16).fillColor(bColor);
    doc.text("[ " + badgeText + " ]", 0, y, { width: pw, align: "center" });
    doc.restore();
    y += 35;
  }

  // Date
  doc.save();
  doc.font("Helvetica").fontSize(11).fillColor("#93C5FD");
  doc.text("Date: " + (date || formatDate()), 0, y, { width: pw, align: "center" });
  doc.restore();
  y += 22;

  // Classification
  doc.save();
  doc.font("Helvetica-Oblique").fontSize(10).fillColor("#60A5FA");
  doc.text(classification || "Classification: Internal — Upgrade Assessment Document", 0, y, { width: pw, align: "center" });
  doc.restore();

  // Move cursor past the cover page content
  doc.y = ph - mb - 10;
}

// ═══════════════════════════════════════════
// Footer builder
// ═══════════════════════════════════════════

function drawFooter(doc) {
  ensureSpace(doc, 70);

  const startY = doc.y + 20;
  const pw = doc.page.width;
  const barHeight = 60;

  doc.save();
  doc.rect(0, startY, pw, barHeight).fill("#" + C.navyDark);
  doc.restore();

  doc.save();
  doc.font("Helvetica-Oblique").fontSize(10).fillColor("#FFFFFF");
  doc.text("— End of Document —", 0, startY + 12, { width: pw, align: "center" });
  doc.restore();

  doc.save();
  doc.font("Helvetica").fontSize(9).fillColor("#93C5FD");
  doc.text("Generated by TCS Agentic AI Platform", 0, startY + 30, { width: pw, align: "center" });
  doc.restore();

  doc.y = startY + barHeight + 10;
}

// ═══════════════════════════════════════════
// Checks table builder (colored status cells)
// ═══════════════════════════════════════════

function drawChecksTable(doc, checks) {
  if (!checks || checks.length === 0) {
    drawParagraph(doc, "No checks available.", { italic: true, color: C.gray });
    return;
  }

  const tableWidth = doc.page.width - 100;
  const colWidths = [
    tableWidth * 0.18,
    tableWidth * 0.25,
    tableWidth * 0.12,
    tableWidth * 0.45,
  ];

  const rows = checks.map((check) => {
    const sc = getStatusColor(check.status);
    return [
      safe(check.category),
      safe(check.item),
      { text: safe(check.status), bg: "#" + sc.bg, color: "#" + sc.text, bold: true },
      safe(check.details, "—"),
    ];
  });

  drawTable(doc, ["Category", "Item", "Status", "Details"], rows, { colWidths });
}

// ═══════════════════════════════════════════
// Remediation table builder
// ═══════════════════════════════════════════

function drawRemediationTable(doc, fixes) {
  if (!fixes || fixes.length === 0) {
    drawParagraph(doc, "No remediation actions required.", { italic: true, color: C.gray });
    return;
  }

  const tableWidth = doc.page.width - 100;
  const colWidths = [
    tableWidth * 0.10,
    tableWidth * 0.20,
    tableWidth * 0.35,
    tableWidth * 0.35,
  ];

  const rows = fixes.map((fix) => {
    const sc = getStatusColor(fix.severity);
    return [
      { text: safe(fix.severity), bg: "#" + sc.bg, color: "#" + sc.text, bold: true },
      { text: safe(fix.title), bold: true },
      safe(fix.description, "—"),
      { text: safe(fix.command, "—"), mono: true },
    ];
  });

  drawTable(doc, ["Severity", "Title", "Description", "Command"], rows, { colWidths });
}

// ═══════════════════════════════════════════
// Comparison table builder (pre vs post)
// ═══════════════════════════════════════════

function drawComparisonTable(doc, comparison) {
  if (!comparison) {
    drawParagraph(doc, "No comparison data available.", { italic: true, color: C.gray });
    return;
  }

  const items = [];
  const addItems = (list, changeLabel) => {
    if (!list || list.length === 0) return;
    for (const item of list) {
      const name = typeof item === "string" ? item : (item.item || item.name || item.title || JSON.stringify(item));
      const preStatus = typeof item === "object" ? safe(item.preStatus || item.pre_status, "—") : "—";
      const postStatus = typeof item === "object" ? safe(item.postStatus || item.post_status, "—") : "—";
      items.push({ name, preStatus, postStatus, change: changeLabel });
    }
  };

  addItems(comparison.resolved, "Resolved");
  addItems(comparison.persistent, "Persistent");
  addItems(comparison.newIssues, "New");

  if (items.length === 0) {
    drawParagraph(doc, "No changes detected between pre and post assessment.", { italic: true, color: C.gray });
    return;
  }

  const tableWidth = doc.page.width - 100;
  const colWidths = [
    tableWidth * 0.34,
    tableWidth * 0.20,
    tableWidth * 0.20,
    tableWidth * 0.16,
  ];

  // Extra 10% left unallocated by rounding — redistribute to first column
  colWidths[0] = tableWidth - colWidths[1] - colWidths[2] - colWidths[3];

  const rows = items.map((row) => {
    const changeSc = getStatusColor(row.change);
    return [
      row.name,
      row.preStatus,
      row.postStatus,
      { text: row.change, bg: "#" + changeSc.bg, color: "#" + changeSc.text, bold: true },
    ];
  });

  drawTable(doc, ["Check", "Pre-Status", "Post-Status", "Change"], rows, { colWidths });
}

// ═══════════════════════════════════════════
// Timeline table builder
// ═══════════════════════════════════════════

function drawTimelineTable(doc, snapshots) {
  if (!snapshots || snapshots.length === 0) {
    drawParagraph(doc, "No monitoring snapshots available.", { italic: true, color: C.gray });
    return;
  }

  const tableWidth = doc.page.width - 100;
  const colWidths = [
    tableWidth * 0.22,
    tableWidth * 0.18,
    tableWidth * 0.12,
    tableWidth * 0.18,
    tableWidth * 0.30,
  ];

  const rows = snapshots.map((snap) => [
    formatTimestamp(snap.timestamp),
    { text: safe(snap.phase), bold: true },
    safe(snap.progress, "—"),
    safe(snap.version, "—"),
    safe(snap.message, "—"),
  ]);

  drawTable(doc, ["Timestamp", "Phase", "Progress", "Version", "Message"], rows, { colWidths });
}

// ═══════════════════════════════════════════
// Issue list helper (for component analysis)
// ═══════════════════════════════════════════

function drawIssueList(doc, title, issues, color) {
  drawHeading(doc, title, 3);
  if (!issues || issues.length === 0) {
    drawParagraph(doc, "None detected.", { italic: true, color: C.gray });
    return;
  }
  for (const issue of issues) {
    const text = typeof issue === "string"
      ? issue
      : (issue.name || issue.title || issue.message || JSON.stringify(issue));
    drawBullet(doc, text, { color });
  }
}

/**
 * Draws a detailed component table with structured columns.
 * Used for richer component analysis sections instead of simple bullet lists.
 *
 * @param {PDFDocument} doc
 * @param {string} title - Section heading
 * @param {Array} items - Array of data items
 * @param {Array<{header: string, width: number, accessor: function, colored?: boolean}>} columns
 */
function drawComponentTable(doc, title, items, columns) {
  drawHeading(doc, title, 3);
  if (!items || items.length === 0) {
    drawParagraph(doc, "None detected.", { italic: true, color: C.gray });
    return;
  }
  const tableWidth = doc.page.width - 100;
  const colWidths = columns.map(c => tableWidth * (c.width || (1 / columns.length)));
  const headers = columns.map(c => c.header);
  const rows = items.map(item => columns.map(c => {
    const val = c.accessor(item);
    return c.colored ? { text: String(val || ""), color: "#" + C.red, bold: true } : String(val || "");
  }));
  drawTable(doc, headers, rows, { colWidths, fontSize: 8.5 });
}

// ═══════════════════════════════════════════
// Core PDF generation wrapper
// ═══════════════════════════════════════════

function generatePDF(buildContent) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
      bufferPages: true,
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      buildContent(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ═══════════════════════════════════════════
// 1. PRE-ASSESSMENT REPORT
// ═══════════════════════════════════════════

/**
 * Generates a professional PDF pre-assessment report for a cluster upgrade.
 *
 * @param {Object} session - The upgrade orchestrator session object
 * @returns {Promise<Buffer>} PDF file buffer
 */
export async function generatePreAssessmentReport(session) {
  if (!session) throw new Error("generatePreAssessmentReport: session is required");

  const preflight = session.preflightReport || {};
  const component = session.componentAnalysis || {};
  const remediation = session.remediationPlan || {};
  const crForm = session.crFormData || {};
  const badge = overallBadge(preflight.overall);

  return generatePDF((doc) => {
    // ── Cover Page ──
    drawCoverPage(doc, {
      title: "Cluster Upgrade Pre-Assessment Report",
      subtitle: safe(session.fromVersion, "current") + " → " + safe(session.targetVersion, "target"),
      cluster: safe(session.cluster, "local"),
      versionRange: "Upgrade Path: " + safe(session.fromVersion) + " → " + safe(session.targetVersion),
      date: formatDate(),
      badgeText: badge.text,
      badgeColor: badge.color,
      classification: "Classification: Internal — Upgrade Assessment Document",
    });

    // ── Page 2: Executive Summary ──
    doc.addPage();
    drawHeading(doc, "1. Executive Summary", 1);
    drawParagraph(doc,
      "This pre-assessment report evaluates the readiness of cluster \"" +
      safe(session.cluster, "local") +
      "\" for an upgrade from OpenShift " +
      safe(session.fromVersion) +
      " to " +
      safe(session.targetVersion) +
      "."
    );
    doc.moveDown(0.3);

    drawKVTable(doc, [
      ["Overall Status", badge.text],
      ["Checks Passed", String(preflight.passed || 0)],
      ["Warnings", String(preflight.warnings || 0)],
      ["Failures", String(preflight.failed || 0)],
      ["Total Checks", String(preflight.total || 0)],
      ["Risk Level", safe(crForm.riskLevel, "Not assessed")],
    ], { headerBg: "#" + C.blue });

    // Summary statistics with colored boxes
    doc.moveDown(0.5);
    ensureSpace(doc, 70);
    const preBoxY = doc.y;
    const preBoxW = (doc.page.width - 120) / 4;
    const preStats = [
      { label: "Passed", value: String(preflight.passed || 0), color: C.green, bg: C.greenBg },
      { label: "Warnings", value: String(preflight.warnings || 0), color: C.orange, bg: C.orangeBg },
      { label: "Failed", value: String(preflight.failed || 0), color: C.red, bg: C.redBg },
      { label: "Total", value: String(preflight.total || 0), color: C.navy, bg: C.blueBg },
    ];
    preStats.forEach((stat, i) => {
      const x = 55 + i * (preBoxW + 8);
      doc.save();
      doc.roundedRect(x, preBoxY, preBoxW, 50, 4).fill("#" + stat.bg);
      doc.fontSize(20).font("Helvetica-Bold").fillColor("#" + stat.color)
        .text(stat.value, x, preBoxY + 8, { width: preBoxW, align: "center" });
      doc.fontSize(9).font("Helvetica").fillColor("#" + stat.color)
        .text(stat.label, x, preBoxY + 34, { width: preBoxW, align: "center" });
      doc.restore();
    });
    doc.y = preBoxY + 65;

    // ── Cluster Information ──
    doc.moveDown(0.8);
    drawHeading(doc, "2. Cluster Information", 1);

    drawKVTable(doc, [
      ["Cluster Name", safe(session.cluster, "local")],
      ["Current Version", safe(session.fromVersion)],
      ["Target Version", safe(session.targetVersion)],
      ["Update Channel", safe(session.channel)],
      ["Upgrade Type", safe(session.upgradeType, "standard")],
      ["Session ID", safe(session.id)],
    ]);

    // ── Cluster Operators Status ──
    doc.addPage();
    drawHeading(doc, "3. Cluster Operators Status", 1);
    const allOps = preflight.allClusterOperators || [];
    if (allOps.length > 0) {
      const availCount = allOps.filter(o => o.available).length;
      const degradedCount = allOps.filter(o => o.degraded).length;
      const progressingCount = allOps.filter(o => o.progressing).length;
      drawParagraph(doc,
        `${allOps.length} ClusterOperators found: ${availCount} available, ${degradedCount} degraded, ${progressingCount} progressing.`
      );
      doc.moveDown(0.3);

      const opTableWidth = doc.page.width - 100;
      const opColWidths = [opTableWidth * 0.38, opTableWidth * 0.18, opTableWidth * 0.16, opTableWidth * 0.14, opTableWidth * 0.14];
      const opRows = allOps.map(op => [
        { text: op.name, bold: true },
        safe(op.version, "—"),
        op.available
          ? { text: "Available", bg: "#" + C.greenBg, color: "#" + C.green, bold: true }
          : { text: "Unavailable", bg: "#" + C.redBg, color: "#" + C.red, bold: true },
        op.degraded
          ? { text: "Yes", bg: "#" + C.redBg, color: "#" + C.red, bold: true }
          : { text: "No", bg: "#" + C.greenBg, color: "#" + C.green },
        op.progressing
          ? { text: "Yes", bg: "#" + C.orangeBg, color: "#" + C.orange, bold: true }
          : { text: "No" },
      ]);
      drawTable(doc, ["Operator", "Version", "Available", "Degraded", "Progressing"], opRows, { colWidths: opColWidths, fontSize: 8 });
    } else {
      drawParagraph(doc, "ClusterOperator data not available in this session.", { italic: true, color: C.gray });
    }

    // ── Version & Platform Details ──
    const vd = preflight.versionDelta || {};
    if (vd.kubeFrom || vd.rhelBase || vd.apiRemovals?.length) {
      doc.moveDown(0.8);
      drawHeading(doc, "3.1 Version & Platform Mapping", 2);
      const vdRows = [
        ["Kubernetes (Current)", safe(vd.kubeFrom)],
        ["Kubernetes (Target)", safe(vd.kubeTo)],
        ["Kubernetes Skew", safe(vd.kubeSkew, "0") + " minor version(s)"],
        ["RHEL Base", safe(vd.rhelBase)],
        ["CRI-O Version", safe(vd.criO)],
        ["Estimated Duration", safe(vd.estimatedDuration)],
      ];
      if (vd.errataURL) vdRows.push(["Errata URL", vd.errataURL]);
      if (vd.releaseNotesURL) vdRows.push(["Release Notes", vd.releaseNotesURL]);
      drawKVTable(doc, vdRows, { headerBg: "#" + C.blue });

      if (vd.apiRemovals?.length) {
        doc.moveDown(0.5);
        drawHeading(doc, "3.2 Deprecated / Removed APIs", 2);
        const apiTw = doc.page.width - 100;
        const apiRows = vd.apiRemovals.map(a => [
          safe(a.api || a.resource || a.name || String(a)),
          safe(a.kind || a.type || "—"),
          safe(a.replacement || a.alternative || "—"),
          safe(a.message || a.details || "—"),
        ]);
        drawTable(doc, ["API / Resource", "Kind", "Replacement", "Details"], apiRows, {
          colWidths: [apiTw * 0.30, apiTw * 0.15, apiTw * 0.25, apiTw * 0.30], fontSize: 8.5,
        });
      }
    }

    // ── Pre-Assessment Checks ──
    doc.addPage();
    drawHeading(doc, "4. Pre-Assessment Checks (22-Point)", 1);
    drawParagraph(doc, "Comprehensive checks performed to assess the cluster's upgrade readiness:");
    doc.moveDown(0.3);
    drawChecksTable(doc, preflight.checks);

    // ── Node Topology Detail ──
    const topo = preflight.nodeTopology || {};
    if (topo.total || topo.masters || topo.workers) {
      doc.moveDown(0.8);
      drawHeading(doc, "4.1 Node Topology", 2);
      const topoRows = [
        ["Control Plane (Masters)", String(topo.masters || 0)],
        ["Workers", String(topo.workers || 0)],
        ["Infrastructure", String(topo.infra || 0)],
        ["Total Nodes", String(topo.total || 0)],
      ];
      drawKVTable(doc, topoRows, { headerBg: "#" + C.blue });
    }

    // ── Component Analysis ──
    doc.addPage();
    drawHeading(doc, "5. Component Analysis", 1);
    drawParagraph(doc, "Detailed analysis of cluster components that may affect the upgrade:");
    doc.moveDown(0.3);

    // 5.1 Degraded Operators
    drawComponentTable(doc, "5.1 Degraded Operators", component.degradedOperators, [
      { header: "Operator", width: 0.35, accessor: o => o.name || String(o) },
      { header: "Condition", width: 0.25, accessor: o => o.issue || o.condition || "Degraded" },
      { header: "Details", width: 0.40, accessor: o => o.message || (o.unhealthyPods?.length ? `${o.unhealthyPods.length} unhealthy pods` : "—") },
    ]);
    doc.moveDown(0.5);

    // 5.2 Certificate Issues
    drawComponentTable(doc, "5.2 Certificate Issues", component.certificateIssues, [
      { header: "Certificate", width: 0.35, accessor: c => c.name || c.secret || String(c) },
      { header: "Namespace", width: 0.25, accessor: c => c.namespace || "—" },
      { header: "Issue", width: 0.40, accessor: c => c.message || c.issue || "Expiring" },
    ]);
    doc.moveDown(0.5);

    // 5.3 MCP Issues
    drawComponentTable(doc, "5.3 Machine Config Pool Issues", component.mcpIssues, [
      { header: "Pool", width: 0.25, accessor: m => m.name || String(m) },
      { header: "Status", width: 0.25, accessor: m => m.status || m.issue || "—", colored: true },
      { header: "Details", width: 0.50, accessor: m => m.message || m.details || "—" },
    ]);

    // 5.4 Storage Issues (if present)
    if (component.storageIssues?.length) {
      doc.moveDown(0.5);
      drawComponentTable(doc, "5.4 Storage Issues", component.storageIssues, [
        { header: "Resource", width: 0.30, accessor: s => s.name || s.pvc || String(s) },
        { header: "Namespace", width: 0.25, accessor: s => s.namespace || "—" },
        { header: "Issue", width: 0.45, accessor: s => s.message || s.issue || s.status || "—" },
      ]);
    }

    // 5.5 Network Issues (if present)
    if (component.networkIssues?.length) {
      doc.moveDown(0.5);
      drawComponentTable(doc, "5.5 Network Issues", component.networkIssues, [
        { header: "Resource", width: 0.30, accessor: n => n.name || String(n) },
        { header: "Type", width: 0.20, accessor: n => n.type || n.kind || "—" },
        { header: "Issue", width: 0.50, accessor: n => n.message || n.issue || n.details || "—" },
      ]);
    }

    // 5.6 Failing Pods (if present)
    if (component.failingPods?.length) {
      doc.moveDown(0.5);
      drawComponentTable(doc, "5.6 Failing Pods", component.failingPods, [
        { header: "Pod", width: 0.30, accessor: p => p.name || String(p) },
        { header: "Namespace", width: 0.25, accessor: p => p.namespace || "—" },
        { header: "Status", width: 0.20, accessor: p => p.status || p.phase || "—" },
        { header: "Restarts", width: 0.25, accessor: p => String(p.restarts ?? p.restartCount ?? "—") },
      ]);
    }

    // ── Remediation Plan ──
    doc.addPage();
    drawHeading(doc, "6. Remediation Plan", 1);
    drawParagraph(doc, "The following remediation actions are recommended before proceeding with the upgrade:");
    doc.moveDown(0.3);
    drawRemediationTable(doc, remediation.fixes);

    // ── Remediation Execution Results (if available) ──
    if (session.remediationResults && Object.keys(session.remediationResults).length > 0) {
      const tw = doc.page.width - 100;
      doc.moveDown(0.5);
      drawHeading(doc, "6.1 Remediation Execution Results", 2);
      const resRows = Object.entries(session.remediationResults).map(([fixId, result]) => {
        const fix = (remediation.fixes || []).find(f => f.id === fixId) || {};
        return [
          fix.title || fixId,
          { text: result.success ? "Success" : "Failed", bg: result.success ? "#" + C.greenBg : "#" + C.redBg, color: result.success ? "#" + C.green : "#" + C.red, bold: true },
          result.output || result.message || "—",
        ];
      });
      drawTable(doc, ["Fix", "Result", "Output"], resRows, { colWidths: [tw * 0.25, tw * 0.15, tw * 0.60] });
    }

    // ── Dry-Run Validation (evidence gathered before the CR) ──
    if (session.dryRunResult) {
      doc.moveDown(0.6);
      drawHeading(doc, "6.2 Dry-Run Validation", 2);
      drawParagraph(doc, `Result: ${session.dryRunResult.warnings ? "PASSED WITH WARNINGS" : "PASSED"} — validated before the Change Request was raised.`);
      doc.moveDown(0.2);
      for (const line of String(session.dryRunResult.details || "").split("\n").filter(Boolean).slice(0, 20)) {
        drawParagraph(doc, line, { fontSize: 9 });
      }
    }

    // ── Risk Assessment ──
    doc.moveDown(0.8);
    drawHeading(doc, "7. Risk Assessment & Impact Analysis", 1);
    const checks = preflight.checks || [];
    const failChecks = checks.filter(c => c.status === "fail");
    const warnChecks = checks.filter(c => c.status === "warning");
    const riskLvl = failChecks.length > 0 ? "HIGH" : warnChecks.length > 3 ? "MODERATE" : "LOW";
    const riskCol = riskLvl === "HIGH" ? C.red : riskLvl === "MODERATE" ? C.orange : C.green;
    const riskBg = riskLvl === "HIGH" ? C.redBg : riskLvl === "MODERATE" ? C.orangeBg : C.greenBg;

    drawKVTable(doc, [
      ["Risk Level", riskLvl],
      ["Blocking Issues", String(failChecks.length)],
      ["Warnings", String(warnChecks.length)],
      ["Impact", failChecks.length > 0 ? "High — Upgrade may fail without remediation" : warnChecks.length > 0 ? "Moderate — Non-critical warnings present" : "Low — Cluster is ready for upgrade"],
      ["Rollback Strategy", "etcd snapshot restore (RPO: pre-upgrade snapshot)"],
      ["Estimated RTO", "2 hours (etcd restore + cluster recovery)"],
      ["Maintenance Window", safe(crForm.estimatedDuration || preflight.versionDelta?.estimatedDuration, "~60 minutes")],
    ], { headerBg: "#" + C.blue });

    if (failChecks.length > 0) {
      doc.moveDown(0.5);
      drawHeading(doc, "7.1 Blocking Issues Detail", 2);
      for (const c of failChecks) {
        drawBullet(doc, `${c.category}: ${c.details}`, { color: "#" + C.red });
      }
    }
    if (warnChecks.length > 0) {
      doc.moveDown(0.3);
      drawHeading(doc, "7.2 Warning Details", 2);
      for (const c of warnChecks) {
        drawBullet(doc, `${c.category}: ${c.details}`, { color: "#" + C.orange });
      }
    }

    // ── Change Request ──
    if (session.crTicketId) {
      doc.moveDown(0.8);
      drawHeading(doc, "8. Change Request", 1);
      drawKVTable(doc, [
        ["Ticket ID", session.crTicketId],
        ["System ID", safe(session.crSysId)],
        ["Risk Level", riskLvl],
        ["Estimated Duration", safe(crForm.estimatedDuration || preflight.versionDelta?.estimatedDuration, "N/A")],
        ["Justification", safe(crForm.justification, "Cluster upgrade")],
        ["CR Type", "Normal"],
        ["Category", "Software"],
      ], { headerBg: "#" + C.blue });
    }

    // ── Approval & Sign-Off ──
    doc.moveDown(0.8);
    drawHeading(doc, "9. Approval & Sign-Off", 1);
    drawParagraph(doc, "This report has been generated by TCS Agentic AI automated upgrade assessment system.");
    doc.moveDown(0.3);
    const signTw = doc.page.width - 100;
    drawTable(doc, ["Role", "Name", "Date", "Signature"], [
      ["Prepared By", "TCS Agentic AI (Automated)", formatDate(), "Digital"],
      ["Reviewed By", "", "", ""],
      ["Approved By", "", "", ""],
      ["CAB Approval", "", "", ""],
    ], { colWidths: [signTw * 0.22, signTw * 0.30, signTw * 0.24, signTw * 0.24] });

    // ── Footer ──
    doc.moveDown(1);
    drawFooter(doc);
  });
}

// ═══════════════════════════════════════════
// 2. POST-ASSESSMENT REPORT
// ═══════════════════════════════════════════

/**
 * Generates a professional PDF post-assessment report after a cluster upgrade.
 *
 * @param {Object} session - The upgrade orchestrator session object (after completion)
 * @returns {Promise<Buffer>} PDF file buffer
 */
export async function generatePostAssessmentReport(session) {
  if (!session) throw new Error("generatePostAssessmentReport: session is required");

  const postAssessment = session.postAssessment || {};
  const comparison = postAssessment.comparison || {};
  const postChecks = postAssessment.postChecks || {};
  const snapshots = session.monitoringSnapshots || session.monitoringData || [];

  // Determine overall outcome
  const isSuccess =
    postChecks.overall === "READY" ||
    postChecks.overall === "pass" ||
    (postChecks.failed === 0 && comparison.newIssues && comparison.newIssues.length === 0);
  const outcomeBadge = isSuccess
    ? { text: "SUCCESS", color: "22C55E" }
    : { text: "FAILED", color: "EF4444" };

  return generatePDF((doc) => {
    // ── Cover Page ──
    drawCoverPage(doc, {
      title: "Cluster Upgrade Post-Assessment Report",
      subtitle: safe(session.fromVersion, "current") + " → " + safe(session.targetVersion, "target"),
      cluster: safe(session.cluster, "local"),
      versionRange: "Upgrade Path: " + safe(session.fromVersion) + " → " + safe(session.targetVersion),
      date: formatDate(),
      badgeText: outcomeBadge.text,
      badgeColor: outcomeBadge.color,
      classification: "Classification: Internal — Post-Upgrade Assessment Document",
    });

    // ── Executive Summary ──
    doc.addPage();
    drawHeading(doc, "1. Executive Summary", 1);
    drawParagraph(doc,
      "This post-assessment report summarizes the outcome of the OpenShift cluster upgrade for \"" +
      safe(session.cluster, "local") +
      "\"."
    );
    doc.moveDown(0.3);

    const execStarted = postAssessment.executedAt || session.executedAt;
    const execCompleted = postAssessment.completedAt || session.completedAt;
    drawKVTable(doc, [
      ["Upgrade Outcome", outcomeBadge.text],
      ["Duration", safe(postAssessment.duration, "Not recorded")],
      ["From Version", safe(session.fromVersion)],
      ["To Version", safe(session.targetVersion)],
      ["Verified Version", safe(postAssessment.verifiedVersion, "—")],
      ["Update Channel", safe(session.channel)],
      ["Upgrade Started", execStarted ? new Date(execStarted).toLocaleString() : "—"],
      ["Upgrade Completed", execCompleted ? new Date(execCompleted).toLocaleString() : "—"],
      ["Post-Assessment Run", postAssessment.timestamp ? new Date(postAssessment.timestamp).toLocaleString() : "—"],
      ["Operators (Total / Available / Degraded)", `${postAssessment.operatorSummary?.total || "—"} / ${postAssessment.operatorSummary?.available || "—"} / ${postAssessment.operatorSummary?.degraded || 0}`],
      ["Nodes (Total / Ready)", `${postAssessment.nodeStatus?.total || "—"} / ${postAssessment.nodeStatus?.ready || "—"}`],
      ["Post-Check Passed", String(postChecks.passed || 0)],
      ["Post-Check Warnings", String(postChecks.warnings || 0)],
      ["Post-Check Failures", String(postChecks.failed || 0)],
      ["Issues Resolved", String((comparison.resolved || []).length)],
      ["Persistent Issues", String((comparison.persistent || []).length)],
      ["New Issues", String((comparison.newIssues || []).length)],
    ], { headerBg: "#" + (isSuccess ? C.green : C.red) });

    // Summary statistics with colored boxes
    doc.moveDown(0.5);
    ensureSpace(doc, 70);
    const postBoxY = doc.y;
    const postBoxW = (doc.page.width - 120) / 4;
    const postStats = [
      { label: "Passed", value: String(postChecks.passed || 0), color: C.green, bg: C.greenBg },
      { label: "Warnings", value: String(postChecks.warnings || 0), color: C.orange, bg: C.orangeBg },
      { label: "Failed", value: String(postChecks.failed || 0), color: C.red, bg: C.redBg },
      { label: "Resolved", value: String((comparison.resolved || []).length), color: C.navy, bg: C.blueBg },
    ];
    postStats.forEach((stat, i) => {
      const x = 55 + i * (postBoxW + 8);
      doc.save();
      doc.roundedRect(x, postBoxY, postBoxW, 50, 4).fill("#" + stat.bg);
      doc.fontSize(20).font("Helvetica-Bold").fillColor("#" + stat.color)
        .text(stat.value, x, postBoxY + 8, { width: postBoxW, align: "center" });
      doc.fontSize(9).font("Helvetica").fillColor("#" + stat.color)
        .text(stat.label, x, postBoxY + 34, { width: postBoxW, align: "center" });
      doc.restore();
    });
    doc.y = postBoxY + 65;

    // ── Pre vs Post Comparison ──
    doc.addPage();
    drawHeading(doc, "2. Pre vs Post Comparison", 1);
    drawParagraph(doc, "Side-by-side comparison of cluster health checks before and after the upgrade:");
    doc.moveDown(0.3);
    drawComparisonTable(doc, comparison);

    // ── Resolved Issues ──
    doc.moveDown(0.8);
    drawHeading(doc, "3. Resolved Issues", 1);
    drawParagraph(doc, "Issues from the pre-assessment that were resolved during the upgrade:");
    doc.moveDown(0.3);

    if (comparison.resolved && comparison.resolved.length > 0) {
      const resolvedTw = doc.page.width - 100;
      const resolvedRows = comparison.resolved.map(issue => {
        const name = typeof issue === "string" ? issue : (issue.item || issue.name || issue.title || JSON.stringify(issue));
        const pre = typeof issue === "object" ? safe(issue.preStatus || issue.pre_status, "—") : "—";
        const post = typeof issue === "object" ? safe(issue.postStatus || issue.post_status, "Resolved") : "Resolved";
        return [
          name,
          pre,
          { text: post, bg: "#" + C.greenBg, color: "#" + C.green, bold: true },
        ];
      });
      drawTable(doc, ["Issue", "Pre-Status", "Post-Status"], resolvedRows, {
        colWidths: [resolvedTw * 0.50, resolvedTw * 0.25, resolvedTw * 0.25],
      });
    } else {
      drawParagraph(doc, "No issues were resolved during the upgrade.", { italic: true, color: C.gray });
    }

    // ── Persistent Issues ──
    doc.moveDown(0.8);
    drawHeading(doc, "4. Persistent Issues", 1);
    drawParagraph(doc, "Issues that remain after the upgrade and may require manual attention:");
    doc.moveDown(0.3);

    if (comparison.persistent && comparison.persistent.length > 0) {
      const persistentTw = doc.page.width - 100;
      const persistentRows = comparison.persistent.map(issue => {
        const name = typeof issue === "string" ? issue : (issue.item || issue.name || issue.title || JSON.stringify(issue));
        const status = typeof issue === "object" ? safe(issue.postStatus || issue.status, "Persistent") : "Persistent";
        const details = typeof issue === "object" ? safe(issue.details || issue.message, "—") : "—";
        return [
          name,
          { text: status, bg: "#" + C.orangeBg, color: "#" + C.orange, bold: true },
          details,
        ];
      });
      drawTable(doc, ["Issue", "Status", "Details"], persistentRows, {
        colWidths: [persistentTw * 0.35, persistentTw * 0.20, persistentTw * 0.45],
      });
    } else {
      drawParagraph(doc, "No persistent issues detected.", { italic: true, color: C.gray });
    }

    // ── New Issues ──
    doc.moveDown(0.8);
    drawHeading(doc, "5. New Issues", 1);
    drawParagraph(doc, "New issues detected after the upgrade that were not present before:");
    doc.moveDown(0.3);

    if (comparison.newIssues && comparison.newIssues.length > 0) {
      const newTw = doc.page.width - 100;
      const newRows = comparison.newIssues.map(issue => {
        const name = typeof issue === "string" ? issue : (issue.item || issue.name || issue.title || JSON.stringify(issue));
        const severity = typeof issue === "object" ? safe(issue.severity || issue.status, "New") : "New";
        const details = typeof issue === "object" ? safe(issue.details || issue.message, "—") : "—";
        return [
          name,
          { text: severity, bg: "#" + C.redBg, color: "#" + C.red, bold: true },
          details,
        ];
      });
      drawTable(doc, ["Issue", "Severity", "Details"], newRows, {
        colWidths: [newTw * 0.35, newTw * 0.20, newTw * 0.45],
      });
    } else {
      drawParagraph(doc, "No new issues detected after the upgrade.", { italic: true, color: C.gray });
    }

    // ── Upgrade Timeline ──
    doc.addPage();
    drawHeading(doc, "6. Upgrade Timeline", 1);
    drawParagraph(doc, "Monitoring snapshots captured during the upgrade process:");
    doc.moveDown(0.3);
    drawTimelineTable(doc, Array.isArray(snapshots) ? snapshots : []);

    // ── Post-Assessment Checks ──
    doc.addPage();
    drawHeading(doc, "7. Post-Assessment Checks", 1);
    drawParagraph(doc, "Detailed results of all checks performed after the upgrade:");
    doc.moveDown(0.3);
    drawChecksTable(doc, postChecks.checks);

    // ── Footer ──
    doc.moveDown(1);
    drawFooter(doc);
  });
}

// ===========================================================================
// HTML report — professional, self-contained (inline CSS), openable & printable
// (browser Print → Save as PDF). Mirrors the PDF data for pre/post assessment.
// ===========================================================================
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function statusPill(status) {
  const s = String(status || "").toLowerCase();
  const map = { pass: ["#16a34a", "PASS"], warning: ["#d97706", "WARN"], fail: ["#dc2626", "FAIL"], ready: ["#16a34a", "READY"], not_ready: ["#dc2626", "NOT READY"] };
  const [c, label] = map[s] || ["#64748b", (status || "—").toString().toUpperCase()];
  return `<span style="display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:800;color:#fff;background:${c}">${esc(label)}</span>`;
}
function checksTableHTML(checks) {
  if (!Array.isArray(checks) || !checks.length) return "<p>No checks recorded.</p>";
  const rows = checks.map((c) => `
    <tr>
      <td style="font-weight:600">${esc(c.category)}</td>
      <td>${statusPill(c.status)}</td>
      <td style="color:#475569">${esc(c.details || "")}${c.recommendation ? `<div style="color:#b45309;font-size:12px;margin-top:3px">↳ ${esc(c.recommendation)}</div>` : ""}</td>
    </tr>`).join("");
  return `<table><thead><tr><th style="width:26%">Check</th><th style="width:12%">Status</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function generateReportHTML(session, type = "pre") {
  const isPost = type === "post";
  const pre = session.preflightReport || {};
  const post = session.postAssessment || {};
  const postReport = post.report || {};
  const summary = pre.summary || {};
  const gen = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const title = `${isPost ? "Post" : "Pre"}-Upgrade Assessment Report`;

  const kv = (k, v) => `<tr><td style="color:#64748b;width:42%">${esc(k)}</td><td style="font-weight:600">${esc(v)}</td></tr>`;
  const overall = isPost ? (post.comparison?.postOverall || "UNKNOWN") : (pre.overallStatus || "UNKNOWN");
  const overallColor = /READY|PASS|HEALTHY/i.test(overall) ? "#16a34a" : /FAIL|NOT|BLOCK/i.test(overall) ? "#dc2626" : "#d97706";

  let body = "";
  body += `<section><h2>Summary</h2><table class="kv">
    ${kv("Cluster", session.cluster || "local")}
    ${kv("From version", session.fromVersion || "—")}
    ${kv("Target version", session.targetVersion || "—")}
    ${isPost ? kv("Verified version", post.verifiedVersion || "—") : ""}
    ${kv("Upgrade type", session.upgradeType || "patch")}
    ${isPost && post.duration ? kv("Upgrade duration", post.duration) : ""}
    ${kv("Assessment status", overall)}
    ${kv("Generated", gen)}
  </table></section>`;

  // Dry-run validation evidence (shown on both pre and post reports when present).
  const dr = session.dryRunResult;
  const dryRunHTML = dr ? `<section><h2>Dry-Run Validation</h2>
    <p style="margin:0 0 8px">${statusPill(dr.warnings ? "warning" : "pass")} <b>${dr.warnings ? "PASSED WITH WARNINGS" : "PASSED"}</b> — validated before the Change Request.</p>
    <pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;font-size:12px;white-space:pre-wrap;overflow:auto">${esc(dr.details || "")}</pre></section>` : "";

  if (!isPost) {
    body += `<section><h2>Pre-Assessment (${summary.pass ?? 0} passed · ${summary.warning ?? 0} warnings · ${summary.fail ?? 0} failed)</h2>${checksTableHTML(pre.checks)}</section>`;
    body += dryRunHTML;
  } else {
    const cmp = post.comparison || {};
    const op = post.operatorSummary || {};
    const nd = post.nodeStatus || {};
    body += `<section><h2>Verification</h2><table class="kv">
      ${kv("Cluster Operators", `${op.available ?? "?"}/${op.total ?? "?"} available · ${op.degraded ?? 0} degraded · ${op.progressing ?? 0} progressing`)}
      ${kv("Nodes", `${nd.ready ?? "?"}/${nd.total ?? "?"} ready`)}
      ${kv("Version match", (post.verifiedVersion === session.targetVersion) ? "matches target ✔" : "mismatch ✗")}
    </table></section>`;
    body += `<section><h2>Pre → Post comparison</h2><table class="kv">
      ${kv("Resolved issues", (cmp.resolved || []).join(", ") || "none")}
      ${kv("Persistent issues", (cmp.persistent || []).join(", ") || "none")}
      ${kv("New issues", (cmp.newIssues || []).join(", ") || "none")}
    </table></section>`;
    body += `<section><h2>Post-Assessment Checks</h2>${checksTableHTML(postReport.checks)}</section>`;
    body += dryRunHTML;
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} — ${esc(session.cluster || "")}</title>
<style>
  *{box-sizing:border-box} body{font-family:'Segoe UI',Inter,system-ui,sans-serif;color:#0f172a;margin:0;background:#f1f5f9}
  .page{max-width:900px;margin:24px auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;box-shadow:0 6px 24px rgba(15,23,42,.06)}
  header{padding:22px 28px;background:linear-gradient(90deg,#0b1e5b,#1e40af);color:#fff}
  header .brand{font-size:12px;font-weight:800;letter-spacing:.14em;opacity:.85}
  header h1{margin:6px 0 2px;font-size:22px}
  header .sub{font-size:13px;opacity:.9}
  .banner{padding:10px 28px;background:${overallColor}14;color:${overallColor};font-weight:800;border-bottom:1px solid #e2e8f0}
  main{padding:8px 28px 24px}
  section{margin:18px 0}
  h2{font-size:15px;margin:0 0 8px;color:#0b1e5b;border-bottom:2px solid #e2e8f0;padding-bottom:5px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;background:#f8fafc;color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:7px 9px;border-bottom:1px solid #e2e8f0}
  td{padding:7px 9px;border-bottom:1px solid #eef2f7;vertical-align:top}
  table.kv td{border-bottom:1px solid #f1f5f9}
  footer{padding:14px 28px;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0}
  @media print{body{background:#fff}.page{border:none;box-shadow:none;margin:0;max-width:none}}
</style></head><body>
<div class="page">
  <header>
    <div class="brand">TCS AGENTIC AI · ENTERPRISE INTELLIGENCE PLATFORM</div>
    <h1>${esc(title)}</h1>
    <div class="sub">Cluster <b>${esc(session.cluster || "local")}</b> · ${esc(session.fromVersion || "?")} → ${esc(session.targetVersion || "?")}</div>
  </header>
  <div class="banner">● Overall: ${esc(overall)}</div>
  <main>${body}</main>
  <footer>Generated ${esc(gen)} by TCS Agentic AI. This report is a point-in-time assessment; re-run before executing changes. © Tata Consultancy Services.</footer>
</div>
<script>if(location.search.includes('print=1')){window.print()}</script>
</body></html>`;
}
