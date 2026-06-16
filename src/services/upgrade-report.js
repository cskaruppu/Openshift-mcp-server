/**
 * Upgrade Report Generator — Professional DOCX reports for OpenShift cluster upgrades.
 *
 * Generates two report types:
 *   1. Pre-Assessment Report  — before upgrade execution
 *   2. Post-Assessment Report — after upgrade completion
 *
 * Uses the same styling conventions as docs/gen-hld-lld-doc.js.
 */

import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  TextRun,
  HeadingLevel,
  WidthType,
  BorderStyle,
  AlignmentType,
  PageBreak,
  ShadingType,
  VerticalAlign,
} from "docx";

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
// Border presets
// ═══════════════════════════════════════════

const noBorder = { style: BorderStyle.NONE, size: 0, color: C.white };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };
const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: C.grayBorder };
const thinBorders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

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
// Shared docx helper functions
// ═══════════════════════════════════════════

function heading(text, level) {
  const map = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 };
  return new Paragraph({
    text,
    heading: map[level] || HeadingLevel.HEADING_1,
    spacing: { before: 300, after: 100 },
  });
}

function para(text, opts = {}) {
  return new Paragraph({
    children: [
      new TextRun({
        text,
        bold: opts.bold,
        italics: opts.italic,
        size: opts.size || 22,
        font: opts.font || "Calibri",
        color: opts.color,
      }),
    ],
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
  const children =
    typeof content === "string"
      ? [
          new Paragraph({
            children: [
              new TextRun({
                text: content,
                bold: opts.bold,
                size: opts.size || 20,
                color: opts.color || C.black,
                font: opts.font || "Calibri",
              }),
            ],
            alignment: opts.align || AlignmentType.LEFT,
            spacing: { after: 0, before: 0 },
          }),
        ]
      : Array.isArray(content)
        ? content
        : [content];
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
  return styledCell(text, {
    bold: true,
    color: C.white,
    shading: opts.shading || C.navy,
    align: opts.align || AlignmentType.LEFT,
    width: opts.width,
    size: opts.size || 20,
    colSpan: opts.colSpan,
  });
}

function dataTable(headers, dataRows, colWidths, opts = {}) {
  const w = colWidths || headers.map(() => Math.floor(100 / headers.length));
  const headerColor = opts.headerColor || C.navy;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: headers.map((h, i) => headerCell(h, { width: w[i], shading: headerColor })),
      }),
      ...dataRows.map((row, ri) =>
        new TableRow({
          children: row.map((c, i) =>
            styledCell(c, { width: w[i], shading: ri % 2 === 1 ? C.grayLight : C.white })
          ),
        })
      ),
    ],
  });
}

function kvTable(rows, opts = {}) {
  const color = opts.color || C.navy;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          headerCell("Parameter", { width: 35, shading: color }),
          headerCell("Value", { width: 65, shading: color }),
        ],
      }),
      ...rows.map(([k, v], i) =>
        new TableRow({
          children: [
            styledCell(k, { width: 35, bold: true, shading: i % 2 === 1 ? C.grayLight : C.white }),
            styledCell(v, { width: 65, shading: i % 2 === 1 ? C.grayLight : C.white }),
          ],
        })
      ),
    ],
  });
}

/**
 * Creates a status-colored cell (text + background shading).
 */
function statusCell(status, opts = {}) {
  const sc = getStatusColor(status);
  return styledCell(status, {
    bold: true,
    color: sc.text,
    shading: sc.bg,
    width: opts.width,
    align: AlignmentType.CENTER,
  });
}

/**
 * Creates a code-style block (monospace, light background, accent left border).
 */
function codeBlock(lines, accentColor) {
  const accent = accentColor || C.blue;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: lines.map(
              (l) =>
                new Paragraph({
                  children: [new TextRun({ text: l, size: 18, color: C.black, font: "Consolas" })],
                  spacing: { after: 8 },
                })
            ),
            shading: { fill: "F8FAFC", type: ShadingType.CLEAR },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 1, color: C.grayBorder },
              bottom: { style: BorderStyle.SINGLE, size: 1, color: C.grayBorder },
              left: { style: BorderStyle.SINGLE, size: 4, color: accent },
              right: { style: BorderStyle.SINGLE, size: 1, color: C.grayBorder },
            },
            margins: { top: 80, bottom: 80, left: 140, right: 140 },
          }),
        ],
      }),
    ],
  });
}

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

// ═══════════════════════════════════════════
// Cover page builder
// ═══════════════════════════════════════════

function buildCoverPage({ title, subtitle, cluster, versionRange, date, classification, badgeText, badgeColor }) {
  const children = [
    new Paragraph({ spacing: { before: 400 } }),
    new Paragraph({
      children: [new TextRun({ text: "TCS KubeNexus AI", bold: true, size: 56, color: C.white, font: "Calibri" })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
    }),
    new Paragraph({
      children: [new TextRun({ text: title, size: 36, color: "93C5FD", font: "Calibri" })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [new TextRun({ text: "──────────────────────────────", size: 20, color: "3B82F6" })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
    }),
  ];

  if (subtitle) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: subtitle, size: 28, color: C.white, font: "Calibri", italics: true })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
      })
    );
  }

  if (cluster) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `Cluster: ${cluster}`, size: 24, color: "93C5FD" })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 40 },
      })
    );
  }

  if (versionRange) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: versionRange, size: 24, color: "93C5FD" })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 40 },
      })
    );
  }

  // Status badge
  if (badgeText) {
    const bColor = badgeColor || C.blue;
    children.push(
      new Paragraph({ spacing: { before: 80 } }),
      new Paragraph({
        children: [new TextRun({ text: `[ ${badgeText} ]`, bold: true, size: 32, color: bColor, font: "Calibri" })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 80 },
      })
    );
  }

  children.push(
    new Paragraph({
      children: [new TextRun({ text: `Date: ${date || formatDate()}`, size: 22, color: "93C5FD" })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: classification || "Classification: Internal — Upgrade Assessment Document",
          size: 20,
          color: "60A5FA",
          italics: true,
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
    })
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children,
            shading: { fill: C.navyDark, type: ShadingType.CLEAR },
            borders: noBorders,
            margins: { top: 200, bottom: 200, left: 300, right: 300 },
          }),
        ],
      }),
    ],
  });
}

// ═══════════════════════════════════════════
// Footer builder
// ═══════════════════════════════════════════

function buildFooter() {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [
              new Paragraph({
                children: [new TextRun({ text: "— End of Document —", size: 20, color: C.white, italics: true })],
                alignment: AlignmentType.CENTER,
                spacing: { after: 20 },
              }),
              new Paragraph({
                children: [new TextRun({ text: "Generated by TCS KubeNexus AI Platform", size: 18, color: "93C5FD" })],
                alignment: AlignmentType.CENTER,
                spacing: { after: 0 },
              }),
            ],
            shading: { fill: C.navyDark, type: ShadingType.CLEAR },
            borders: noBorders,
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
          }),
        ],
      }),
    ],
  });
}

// ═══════════════════════════════════════════
// Build status badge color for cover pages
// ═══════════════════════════════════════════

function overallBadge(overall) {
  const s = (overall || "").toUpperCase();
  if (s === "READY" || s === "SUCCESS" || s === "PASS") return { text: "READY", color: "22C55E" };
  if (s === "READY_WITH_WARNINGS") return { text: "READY WITH WARNINGS", color: "F59E0B" };
  if (s === "NOT_READY" || s === "FAILED" || s === "FAIL") return { text: "NOT READY", color: "EF4444" };
  return { text: s || "UNKNOWN", color: C.gray };
}

// ═══════════════════════════════════════════
// Pre-Assessment checks table with colored status
// ═══════════════════════════════════════════

function buildChecksTable(checks, headerColor) {
  if (!checks || checks.length === 0) {
    return para("No checks available.", { italic: true, color: C.gray });
  }

  const w = [18, 25, 12, 45];
  const hColor = headerColor || C.navy;

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          headerCell("Category", { width: w[0], shading: hColor }),
          headerCell("Item", { width: w[1], shading: hColor }),
          headerCell("Status", { width: w[2], shading: hColor }),
          headerCell("Details", { width: w[3], shading: hColor }),
        ],
      }),
      ...checks.map((check, ri) => {
        const sc = getStatusColor(check.status);
        return new TableRow({
          children: [
            styledCell(safe(check.category), { width: w[0], shading: ri % 2 === 1 ? C.grayLight : C.white }),
            styledCell(safe(check.item), { width: w[1], shading: ri % 2 === 1 ? C.grayLight : C.white }),
            styledCell(safe(check.status), {
              width: w[2],
              bold: true,
              color: sc.text,
              shading: sc.bg,
              align: AlignmentType.CENTER,
            }),
            styledCell(safe(check.details, "—"), { width: w[3], shading: ri % 2 === 1 ? C.grayLight : C.white }),
          ],
        });
      }),
    ],
  });
}

// ═══════════════════════════════════════════
// Remediation table
// ═══════════════════════════════════════════

function buildRemediationTable(fixes) {
  if (!fixes || fixes.length === 0) {
    return para("No remediation actions required.", { italic: true, color: C.gray });
  }

  const w = [10, 20, 35, 35];

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          headerCell("Severity", { width: w[0], shading: C.navy }),
          headerCell("Title", { width: w[1], shading: C.navy }),
          headerCell("Description", { width: w[2], shading: C.navy }),
          headerCell("Command", { width: w[3], shading: C.navy }),
        ],
      }),
      ...fixes.map((fix, ri) => {
        const sc = getStatusColor(fix.severity);
        return new TableRow({
          children: [
            styledCell(safe(fix.severity), {
              width: w[0],
              bold: true,
              color: sc.text,
              shading: sc.bg,
              align: AlignmentType.CENTER,
            }),
            styledCell(safe(fix.title), {
              width: w[1],
              bold: true,
              shading: ri % 2 === 1 ? C.grayLight : C.white,
            }),
            styledCell(safe(fix.description, "—"), {
              width: w[2],
              shading: ri % 2 === 1 ? C.grayLight : C.white,
            }),
            styledCell(safe(fix.command, "—"), {
              width: w[3],
              font: "Consolas",
              size: 18,
              shading: ri % 2 === 1 ? C.grayLight : C.white,
            }),
          ],
        });
      }),
    ],
  });
}

// ═══════════════════════════════════════════
// Issue list (for component analysis sections)
// ═══════════════════════════════════════════

function buildIssueList(title, issues, color) {
  const children = [heading(title, 3)];
  if (!issues || issues.length === 0) {
    children.push(para("None detected.", { italic: true, color: C.gray }));
    return children;
  }
  for (const issue of issues) {
    const text = typeof issue === "string" ? issue : (issue.name || issue.title || issue.message || JSON.stringify(issue));
    children.push(bulletPara(text, { color }));
  }
  return children;
}

// ═══════════════════════════════════════════
// Comparison table (pre vs post)
// ═══════════════════════════════════════════

function buildComparisonTable(comparison) {
  if (!comparison) {
    return para("No comparison data available.", { italic: true, color: C.gray });
  }

  const rows = [];
  const addRows = (items, changeLabel) => {
    if (!items || items.length === 0) return;
    for (const item of items) {
      const name = typeof item === "string" ? item : (item.item || item.name || item.title || JSON.stringify(item));
      const preStatus = typeof item === "object" ? safe(item.preStatus || item.pre_status, "—") : "—";
      const postStatus = typeof item === "object" ? safe(item.postStatus || item.post_status, "—") : "—";
      rows.push({ name, preStatus, postStatus, change: changeLabel });
    }
  };

  addRows(comparison.resolved, "Resolved");
  addRows(comparison.persistent, "Persistent");
  addRows(comparison.newIssues, "New");

  if (rows.length === 0) {
    return para("No changes detected between pre and post assessment.", { italic: true, color: C.gray });
  }

  const w = [30, 18, 18, 14];

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          headerCell("Check", { width: w[0], shading: C.navy }),
          headerCell("Pre-Status", { width: w[1], shading: C.navy }),
          headerCell("Post-Status", { width: w[2], shading: C.navy }),
          headerCell("Change", { width: w[3], shading: C.navy }),
        ],
      }),
      ...rows.map((row, ri) => {
        const changeSc = getStatusColor(row.change);
        return new TableRow({
          children: [
            styledCell(row.name, { width: w[0], shading: ri % 2 === 1 ? C.grayLight : C.white }),
            styledCell(row.preStatus, { width: w[1], shading: ri % 2 === 1 ? C.grayLight : C.white, align: AlignmentType.CENTER }),
            styledCell(row.postStatus, { width: w[2], shading: ri % 2 === 1 ? C.grayLight : C.white, align: AlignmentType.CENTER }),
            styledCell(row.change, {
              width: w[3],
              bold: true,
              color: changeSc.text,
              shading: changeSc.bg,
              align: AlignmentType.CENTER,
            }),
          ],
        });
      }),
    ],
  });
}

// ═══════════════════════════════════════════
// Timeline table (monitoring snapshots)
// ═══════════════════════════════════════════

function buildTimelineTable(snapshots) {
  if (!snapshots || snapshots.length === 0) {
    return para("No monitoring snapshots available.", { italic: true, color: C.gray });
  }

  const w = [22, 18, 12, 18, 30];

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          headerCell("Timestamp", { width: w[0], shading: C.navy }),
          headerCell("Phase", { width: w[1], shading: C.navy }),
          headerCell("Progress", { width: w[2], shading: C.navy }),
          headerCell("Version", { width: w[3], shading: C.navy }),
          headerCell("Message", { width: w[4], shading: C.navy }),
        ],
      }),
      ...snapshots.map((snap, ri) =>
        new TableRow({
          children: [
            styledCell(formatTimestamp(snap.timestamp), { width: w[0], size: 18, shading: ri % 2 === 1 ? C.grayLight : C.white }),
            styledCell(safe(snap.phase), { width: w[1], bold: true, shading: ri % 2 === 1 ? C.grayLight : C.white }),
            styledCell(safe(snap.progress, "—"), { width: w[2], align: AlignmentType.CENTER, shading: ri % 2 === 1 ? C.grayLight : C.white }),
            styledCell(safe(snap.version, "—"), { width: w[3], shading: ri % 2 === 1 ? C.grayLight : C.white }),
            styledCell(safe(snap.message, "—"), { width: w[4], shading: ri % 2 === 1 ? C.grayLight : C.white }),
          ],
        })
      ),
    ],
  });
}

// ═══════════════════════════════════════════
// 1. PRE-ASSESSMENT REPORT
// ═══════════════════════════════════════════

/**
 * Generates a professional DOCX pre-assessment report for a cluster upgrade.
 *
 * @param {Object} session - The upgrade orchestrator session object
 * @returns {Promise<Buffer>} DOCX file buffer
 */
export async function generatePreAssessmentReport(session) {
  if (!session) throw new Error("generatePreAssessmentReport: session is required");

  const preflight = session.preflightReport || {};
  const component = session.componentAnalysis || {};
  const remediation = session.remediationPlan || {};
  const crForm = session.crFormData || {};
  const badge = overallBadge(preflight.overall);

  const children = [
    // ── Cover Page ──
    new Paragraph({ spacing: { before: 1200 } }),
    buildCoverPage({
      title: "Cluster Upgrade Pre-Assessment Report",
      subtitle: `${safe(session.fromVersion, "current")} → ${safe(session.targetVersion, "target")}`,
      cluster: safe(session.cluster, "local"),
      versionRange: `Upgrade Path: ${safe(session.fromVersion)} → ${safe(session.targetVersion)}`,
      date: formatDate(),
      badgeText: badge.text,
      badgeColor: badge.color,
      classification: "Classification: Internal — Upgrade Assessment Document",
    }),

    // ── Executive Summary ──
    new Paragraph({ children: [new PageBreak()] }),
    heading("1. Executive Summary", 1),
    para(`This pre-assessment report evaluates the readiness of cluster "${safe(session.cluster, "local")}" for an upgrade from OpenShift ${safe(session.fromVersion)} to ${safe(session.targetVersion)}.`, { after: 120 }),
    kvTable([
      ["Overall Status", badge.text],
      ["Checks Passed", String(preflight.passed || 0)],
      ["Warnings", String(preflight.warnings || 0)],
      ["Failures", String(preflight.failed || 0)],
      ["Total Checks", String(preflight.total || 0)],
      ["Risk Level", safe(crForm.riskLevel, "Not assessed")],
    ], { color: C.blue }),

    // ── Cluster Information ──
    para(""),
    heading("2. Cluster Information", 1),
    kvTable([
      ["Cluster Name", safe(session.cluster, "local")],
      ["Current Version", safe(session.fromVersion)],
      ["Target Version", safe(session.targetVersion)],
      ["Update Channel", safe(session.channel)],
      ["Upgrade Type", safe(session.upgradeType, "standard")],
      ["Session ID", safe(session.id)],
    ]),

    // ── Pre-Assessment Checks ──
    para(""),
    new Paragraph({ children: [new PageBreak()] }),
    heading("3. Pre-Assessment Checks", 1),
    para("The following checks were performed to assess the cluster's upgrade readiness:", { after: 120 }),
    buildChecksTable(preflight.checks),

    // ── Component Analysis ──
    para(""),
    new Paragraph({ children: [new PageBreak()] }),
    heading("4. Component Analysis", 1),
    para("Detailed analysis of cluster components that may affect the upgrade:", { after: 120 }),

    // Degraded operators
    ...buildIssueList("4.1 Degraded Operators", component.degradedOperators, C.red),

    para(""),

    // Certificate issues
    ...buildIssueList("4.2 Certificate Issues", component.certificateIssues, C.orange),

    para(""),

    // MCP issues
    ...buildIssueList("4.3 Machine Config Pool Issues", component.mcpIssues, C.orange),

    // ── Remediation Plan ──
    para(""),
    new Paragraph({ children: [new PageBreak()] }),
    heading("5. Remediation Plan", 1),
    para("The following remediation actions are recommended before proceeding with the upgrade:", { after: 120 }),
    buildRemediationTable(remediation.fixes),

    // ── Cluster Topology ──
    para(""),
    heading("6. Cluster Topology", 1),
    para("Node overview and estimated upgrade duration:", { after: 120 }),
  ];

  // Build topology data from preflight checks if available
  const topologyRows = [];
  if (preflight.checks) {
    const nodeCheck = preflight.checks.find((c) => c.category === "nodes" || c.item === "node_count" || (c.details && c.details.includes("node")));
    if (nodeCheck) {
      topologyRows.push(["Node Information", safe(nodeCheck.details)]);
    }
  }
  // Add CR form data if available
  if (crForm.estimatedDuration) {
    topologyRows.push(["Estimated Duration", crForm.estimatedDuration]);
  }
  if (crForm.justification) {
    topologyRows.push(["Upgrade Justification", crForm.justification]);
  }
  if (crForm.riskLevel) {
    topologyRows.push(["Risk Level", crForm.riskLevel]);
  }

  if (topologyRows.length > 0) {
    children.push(kvTable(topologyRows, { color: C.blue }));
  } else {
    children.push(para("Topology data not available in the current session.", { italic: true, color: C.gray }));
  }

  // ── Footer ──
  children.push(
    new Paragraph({ spacing: { before: 600 } }),
    buildFooter()
  );

  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [
      {
        properties: {
          page: { margin: { top: 1200, bottom: 1200, left: 1200, right: 1200 } },
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

// ═══════════════════════════════════════════
// 2. POST-ASSESSMENT REPORT
// ═══════════════════════════════════════════

/**
 * Generates a professional DOCX post-assessment report after a cluster upgrade.
 *
 * @param {Object} session - The upgrade orchestrator session object (after completion)
 * @returns {Promise<Buffer>} DOCX file buffer
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

  const children = [
    // ── Cover Page ──
    new Paragraph({ spacing: { before: 1200 } }),
    buildCoverPage({
      title: "Cluster Upgrade Post-Assessment Report",
      subtitle: `${safe(session.fromVersion, "current")} → ${safe(session.targetVersion, "target")}`,
      cluster: safe(session.cluster, "local"),
      versionRange: `Upgrade Path: ${safe(session.fromVersion)} → ${safe(session.targetVersion)}`,
      date: formatDate(),
      badgeText: outcomeBadge.text,
      badgeColor: outcomeBadge.color,
      classification: "Classification: Internal — Post-Upgrade Assessment Document",
    }),

    // ── Executive Summary ──
    new Paragraph({ children: [new PageBreak()] }),
    heading("1. Executive Summary", 1),
    para(`This post-assessment report summarizes the outcome of the OpenShift cluster upgrade for "${safe(session.cluster, "local")}".`, { after: 120 }),
    kvTable([
      ["Upgrade Outcome", outcomeBadge.text],
      ["Duration", safe(postAssessment.duration, "Not recorded")],
      ["From Version", safe(session.fromVersion)],
      ["To Version", safe(session.targetVersion)],
      ["Update Channel", safe(session.channel)],
      ["Post-Check Passed", String(postChecks.passed || 0)],
      ["Post-Check Warnings", String(postChecks.warnings || 0)],
      ["Post-Check Failures", String(postChecks.failed || 0)],
      ["Issues Resolved", String((comparison.resolved || []).length)],
      ["Persistent Issues", String((comparison.persistent || []).length)],
      ["New Issues", String((comparison.newIssues || []).length)],
    ], { color: isSuccess ? C.green : C.red }),

    // ── Pre vs Post Comparison ──
    para(""),
    new Paragraph({ children: [new PageBreak()] }),
    heading("2. Pre vs Post Comparison", 1),
    para("Side-by-side comparison of cluster health checks before and after the upgrade:", { after: 120 }),
    buildComparisonTable(comparison),

    // ── Resolved Issues ──
    para(""),
    heading("3. Resolved Issues", 1),
    para("Issues from the pre-assessment that were resolved during the upgrade:", { after: 120 }),
  ];

  if (comparison.resolved && comparison.resolved.length > 0) {
    for (const issue of comparison.resolved) {
      const text = typeof issue === "string" ? issue : (issue.item || issue.name || issue.title || JSON.stringify(issue));
      children.push(bulletPara(text, { color: C.green }));
    }
  } else {
    children.push(para("No issues were resolved during the upgrade.", { italic: true, color: C.gray }));
  }

  // ── Persistent Issues ──
  children.push(
    para(""),
    heading("4. Persistent Issues", 1),
    para("Issues that remain after the upgrade and may require manual attention:", { after: 120 })
  );

  if (comparison.persistent && comparison.persistent.length > 0) {
    for (const issue of comparison.persistent) {
      const text = typeof issue === "string" ? issue : (issue.item || issue.name || issue.title || JSON.stringify(issue));
      children.push(bulletPara(text, { color: C.orange }));
    }
  } else {
    children.push(para("No persistent issues detected.", { italic: true, color: C.gray }));
  }

  // ── New Issues ──
  children.push(
    para(""),
    heading("5. New Issues", 1),
    para("New issues detected after the upgrade that were not present before:", { after: 120 })
  );

  if (comparison.newIssues && comparison.newIssues.length > 0) {
    for (const issue of comparison.newIssues) {
      const text = typeof issue === "string" ? issue : (issue.item || issue.name || issue.title || JSON.stringify(issue));
      children.push(bulletPara(text, { color: C.red }));
    }
  } else {
    children.push(para("No new issues detected after the upgrade.", { italic: true, color: C.gray }));
  }

  // ── Upgrade Timeline ──
  children.push(
    para(""),
    new Paragraph({ children: [new PageBreak()] }),
    heading("6. Upgrade Timeline", 1),
    para("Monitoring snapshots captured during the upgrade process:", { after: 120 }),
    buildTimelineTable(Array.isArray(snapshots) ? snapshots : [])
  );

  // ── Post-Assessment Checks ──
  children.push(
    para(""),
    new Paragraph({ children: [new PageBreak()] }),
    heading("7. Post-Assessment Checks", 1),
    para("Detailed results of all checks performed after the upgrade:", { after: 120 }),
    buildChecksTable(postChecks.checks)
  );

  // ── Footer ──
  children.push(
    new Paragraph({ spacing: { before: 600 } }),
    buildFooter()
  );

  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [
      {
        properties: {
          page: { margin: { top: 1200, bottom: 1200, left: 1200, right: 1200 } },
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
