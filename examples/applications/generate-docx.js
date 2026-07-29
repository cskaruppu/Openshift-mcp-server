import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, WidthType, BorderStyle, AlignmentType } from "docx";
import { writeFile } from "node:fs/promises";

function heading(text, level) {
  const map = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
  };
  return new Paragraph({ text, heading: map[level] || HeadingLevel.HEADING_1, spacing: { before: 300, after: 100 } });
}

function para(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, bold: opts.bold, italics: opts.italic, size: opts.size || 22 })],
    spacing: { after: 80 },
  });
}

const borderStyle = { style: BorderStyle.SINGLE, size: 1, color: "999999" };
const borders = { top: borderStyle, bottom: borderStyle, left: borderStyle, right: borderStyle };

function cell(text, opts = {}) {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold: opts.bold, size: 20 })] })],
    width: { size: opts.width || 50, type: WidthType.PERCENTAGE },
    borders,
  });
}

function kvTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [cell("Field", { bold: true, width: 35 }), cell("Value", { bold: true, width: 65 })] }),
      ...rows.map(([k, v]) => new TableRow({ children: [cell(k, { width: 35 }), cell(v, { width: 65 })] })),
    ],
  });
}

function multiColTable(headers, dataRows) {
  const w = Math.floor(100 / headers.length);
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: headers.map((h) => cell(h, { bold: true, width: w })) }),
      ...dataRows.map((row) => new TableRow({ children: row.map((c) => cell(c, { width: w })) })),
    ],
  });
}

const doc = new Document({
  sections: [{
    children: [
      // ── 1. Application Overview ──
      heading("1. Application Overview", 1),
      kvTable([
        ["Application Name", "bookstore"],
        ["Description", "Three-tier bookstore demo: nginx frontend, Node.js API, PostgreSQL DB"],
        ["Business Owner", "Demo Apps Team"],
        ["Technical Owner", "platform-team@example.com"],
        ["Environment", "dev"],
        ["Architecture Pattern", "3-tier (Web → App → DB)"],
      ]),

      // ── 2. Target Platform ──
      heading("2. Target Platform", 1),
      kvTable([
        ["Platform Type", "openshift"],
        ["Cluster Name", "dev-cluster"],
        ["Namespace", "bookstore-dev"],
        ["Deployment Order", "bookstore-db, bookstore-app, bookstore-web"],
      ]),

      // ── 3. Shared Resources ──
      heading("3. Shared Resources", 1),
      heading("Secrets", 2),
      multiColTable(
        ["Secret Name", "Keys", "Used By"],
        [["bookstore-db-credentials", "username, password, database", "bookstore-db, bookstore-app"]],
      ),
      para(""),
      heading("ConfigMaps", 2),
      multiColTable(
        ["ConfigMap Name", "Keys", "Used By"],
        [["bookstore-app-config", "LOG_LEVEL=info, API_VERSION=v1", "bookstore-app"]],
      ),

      // ── 4. Tier 1 — Database ──
      heading("4. Tier 1 — Database (PostgreSQL)", 1),
      kvTable([
        ["Component Name", "bookstore-db"],
        ["Role", "database"],
        ["Container Image", "registry.redhat.io/rhel9/postgresql-15:latest"],
        ["Replicas", "1 (single instance)"],
        ["Port", "5432"],
        ["Protocol", "TCP"],
        ["CPU Request", "200m"],
        ["CPU Limit", "1000m"],
        ["Memory Request", "512Mi"],
        ["Memory Limit", "2Gi"],
        ["Storage Size", "10Gi"],
        ["Storage Mount Path", "/var/lib/pgsql/data"],
        ["Storage Class", "default"],
        ["Access Mode", "ReadWriteOnce"],
        ["Expose Externally", "No"],
        ["Run As Non-Root", "Yes"],
        ["Read-Only Root Filesystem", "No"],
        ["Drop All Capabilities", "Yes"],
      ]),

      heading("Database Environment Variables", 2),
      multiColTable(
        ["Name", "From Secret", "Secret Key"],
        [
          ["POSTGRESQL_USER", "bookstore-db-credentials", "username"],
          ["POSTGRESQL_PASSWORD", "bookstore-db-credentials", "password"],
          ["POSTGRESQL_DATABASE", "bookstore-db-credentials", "database"],
        ],
      ),

      heading("Database Health Probes", 2),
      multiColTable(
        ["Probe", "Type", "Command", "Initial Delay", "Period"],
        [
          ["Liveness", "exec", "pg_isready -U $POSTGRESQL_USER", "30", "10"],
          ["Readiness", "exec", "pg_isready -U $POSTGRESQL_USER", "5", "5"],
        ],
      ),

      heading("Database Init SQL", 2),
      para("CREATE TABLE IF NOT EXISTS books(id SERIAL PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, price NUMERIC(10,2), created_at TIMESTAMP DEFAULT NOW())", { italic: true }),

      // ── 5. Tier 2 — Application ──
      heading("5. Tier 2 — Application (Node.js API)", 1),
      kvTable([
        ["Component Name", "bookstore-app"],
        ["Role", "app"],
        ["Container Image", "quay.io/myorg/bookstore-api:v1.0.0"],
        ["Replicas Min", "2"],
        ["Replicas Max", "6"],
        ["Port", "3000"],
        ["Protocol", "TCP"],
        ["CPU Request", "100m"],
        ["CPU Limit", "500m"],
        ["Memory Request", "256Mi"],
        ["Memory Limit", "1Gi"],
        ["Expose Externally", "No"],
        ["Run As Non-Root", "Yes"],
        ["Read-Only Root Filesystem", "Yes"],
        ["Drop All Capabilities", "Yes"],
        ["Depends On", "bookstore-db"],
      ]),

      heading("Application Environment Variables", 2),
      multiColTable(
        ["Name", "Value", "From Secret", "Secret Key"],
        [
          ["DB_HOST", "bookstore-db.bookstore-dev.svc.cluster.local", "", ""],
          ["DB_PORT", "5432", "", ""],
          ["DB_USER", "", "bookstore-db-credentials", "username"],
          ["DB_PASSWORD", "", "bookstore-db-credentials", "password"],
          ["DB_NAME", "", "bookstore-db-credentials", "database"],
        ],
      ),

      heading("Application Health Probes", 2),
      multiColTable(
        ["Probe", "Type", "Path", "Port", "Initial Delay", "Period"],
        [
          ["Liveness", "http", "/healthz", "3000", "20", "10"],
          ["Readiness", "http", "/ready", "3000", "5", "5"],
        ],
      ),

      // ── 6. Tier 3 — Frontend ──
      heading("6. Tier 3 — Frontend (nginx)", 1),
      kvTable([
        ["Component Name", "bookstore-web"],
        ["Role", "frontend"],
        ["Container Image", "registry.redhat.io/rhel9/nginx-122:latest"],
        ["Replicas Min", "2"],
        ["Replicas Max", "4"],
        ["Port", "8080"],
        ["Protocol", "TCP"],
        ["CPU Request", "50m"],
        ["CPU Limit", "200m"],
        ["Memory Request", "64Mi"],
        ["Memory Limit", "256Mi"],
        ["Expose Externally", "Yes"],
        ["Hostname", "bookstore.apps.example.com"],
        ["TLS", "edge"],
        ["Run As Non-Root", "Yes"],
        ["Read-Only Root Filesystem", "No"],
        ["Drop All Capabilities", "Yes"],
        ["Depends On", "bookstore-app"],
      ]),

      heading("Frontend Reverse Proxy", 2),
      multiColTable(
        ["Path", "Upstream"],
        [["/api/*", "http://bookstore-app:3000"]],
      ),

      heading("Frontend Health Probes", 2),
      multiColTable(
        ["Probe", "Type", "Path", "Port", "Initial Delay", "Period"],
        [
          ["Liveness", "http", "/", "8080", "10", "10"],
          ["Readiness", "http", "/", "8080", "5", "5"],
        ],
      ),

      // ── 7. Network Connectivity Matrix ──
      heading("7. Network Connectivity Matrix", 1),
      multiColTable(
        ["From", "To", "Port", "Protocol", "Allowed"],
        [
          ["internet", "bookstore-web", "8080", "TCP", "yes"],
          ["bookstore-web", "bookstore-app", "3000", "TCP", "yes"],
          ["bookstore-app", "bookstore-db", "5432", "TCP", "yes"],
          ["bookstore-web", "bookstore-db", "5432", "TCP", "no"],
          ["internet", "bookstore-app", "3000", "TCP", "no"],
          ["internet", "bookstore-db", "5432", "TCP", "no"],
        ],
      ),

      // ── 8. Validation Tests ──
      heading("8. Post-Deployment Validation", 1),
      multiColTable(
        ["Description", "Command", "Expected"],
        [
          ["Frontend accessible", "curl https://bookstore.apps.example.com", "200 OK, HTML"],
          ["API health check", "curl http://bookstore-app:3000/healthz", "200 OK"],
          ["List books endpoint", "curl http://bookstore-app:3000/api/v1/books", "200 OK, []"],
          ["All pods running", "oc get pods -n bookstore-dev", "All Running/Ready"],
          ["No crash loops", "oc get events -n bookstore-dev --field-selector reason=BackOff", "No events"],
        ],
      ),

      // ── 9. Rollback Criteria ──
      heading("9. Rollback Criteria", 1),
      para("Auto-rollback (remove all created resources) if ANY of the following occur:"),
      para("• Any tier fails to become Ready within 3 minutes"),
      para("• Post-deployment validation fails"),
      para("• Any pod enters CrashLoopBackOff within 5 minutes"),
      para("• Database init job fails after 3 retries"),
    ],
  }],
});

const buffer = await Packer.toBuffer(doc);
await writeFile(new URL("ThreeTier-Bookstore-Deploy.docx", import.meta.url), buffer);
console.log("Created: examples/applications/ThreeTier-Bookstore-Deploy.docx (" + buffer.length + " bytes)");
