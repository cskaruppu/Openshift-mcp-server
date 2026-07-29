/**
 * TCS Agentic AI — UC-04: Security & Compliance Governance
 * Generates: TCS-Agentic-AI-UC04-Security-Compliance.xlsx (beside this script)
 */
const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");

const OUT = path.join(__dirname, "TCS-Agentic-AI-UC04-Security-Compliance.xlsx");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const wb = new ExcelJS.Workbook();
wb.creator = "TCS Agentic AI Platform";
wb.created = new Date();

// ── Color palette ──
const C = {
  darkNavy: "0F172A",
  navy: "1E293B",
  tcsBlue: "2563EB",
  lightBlue: "DBEAFE",
  paleBlue: "EFF6FF",
  aiPurple: "7C3AED",
  lightPurple: "EDE9FE",
  autoGreen: "10B981",
  lightGreen: "D1FAE5",
  darkGreen: "166534",
  userAmber: "F59E0B",
  lightAmber: "FEF3C7",
  valCyan: "06B6D4",
  lightCyan: "CFFAFE",
  secRed: "DC2626",
  lightRed: "FEE2E2",
  orange: "EA580C",
  lightOrange: "FFEDD5",
  white: "FFFFFF",
  bgLight: "F8FAFC",
  border: "CBD5E1",
  textDark: "1E293B",
  textMed: "475569",
  textLight: "94A3B8",
  gradeA: "059669",
  gradeB: "2563EB",
  gradeC: "D97706",
  gradeD: "EA580C",
  gradeF: "DC2626",
  gradeABg: "D1FAE5",
  gradeBBg: "DBEAFE",
  gradeCBg: "FEF3C7",
  gradeDBg: "FFEDD5",
  gradeFBg: "FEE2E2",
  criticalBg: "FEE2E2",
  highBg: "FFEDD5",
  mediumBg: "FEF3C7",
  lowBg: "D1FAE5",
};

// ── Reusable style helpers ──
const thin = { style: "thin", color: { argb: "FF" + C.border } };
const thinBorder = { top: thin, bottom: thin, left: thin, right: thin };

function headerFill(color) {
  return { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + color } };
}

function applyHeaderRow(ws, row, numCols, fillColor) {
  const fill = fillColor || C.darkNavy;
  for (let c = 1; c <= numCols; c++) {
    const cell = ws.getCell(row, c);
    cell.font = { name: "Inter", bold: true, color: { argb: "FF" + C.white }, size: 11 };
    cell.fill = headerFill(fill);
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = thinBorder;
  }
}

function applySectionRow(ws, row, numCols, text, fillColor) {
  ws.mergeCells(row, 1, row, numCols);
  const cell = ws.getCell(row, 1);
  cell.value = text;
  cell.font = { name: "Inter", bold: true, color: { argb: "FF" + C.white }, size: 12 };
  cell.fill = headerFill(fillColor || C.tcsBlue);
  cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
  cell.border = thinBorder;
  ws.getRow(row).height = 28;
}

function applyTitleBanner(ws, row, numCols, text, subtitle) {
  ws.mergeCells(row, 1, row, numCols);
  const cell = ws.getCell(row, 1);
  cell.value = text;
  cell.font = { name: "Inter", bold: true, color: { argb: "FF" + C.white }, size: 16 };
  cell.fill = headerFill(C.darkNavy);
  cell.alignment = { horizontal: "center", vertical: "middle" };
  cell.border = thinBorder;
  ws.getRow(row).height = 50;

  if (subtitle) {
    ws.mergeCells(row + 1, 1, row + 1, numCols);
    const sub = ws.getCell(row + 1, 1);
    sub.value = subtitle;
    sub.font = { name: "Inter", size: 11, color: { argb: "FF" + C.textMed }, italic: true };
    sub.fill = headerFill(C.paleBlue);
    sub.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    sub.border = thinBorder;
    ws.getRow(row + 1).height = 40;
  }
}

function applyDataCell(cell, opts = {}) {
  cell.font = {
    name: opts.fontName || "Inter",
    bold: !!opts.bold,
    size: opts.fontSize || 11,
    color: { argb: "FF" + (opts.fontColor || C.textDark) },
  };
  if (opts.fill) cell.fill = headerFill(opts.fill);
  cell.alignment = {
    horizontal: opts.align || "left",
    vertical: opts.valign || "middle",
    wrapText: true,
  };
  cell.border = thinBorder;
}

function setColWidths(ws, widths) {
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
}

function addKVRows(ws, startRow, numCols, items, valueFill) {
  let r = startRow;
  items.forEach((item) => {
    const keyCell = ws.getCell(r, 1);
    keyCell.value = item[0];
    applyDataCell(keyCell, { bold: true, fill: C.bgLight });
    ws.mergeCells(r, 2, r, numCols);
    const valCell = ws.getCell(r, 2);
    valCell.value = item[1];
    applyDataCell(valCell, { fill: valueFill || C.white });
    ws.getRow(r).height = item[2] || 24;
    r++;
  });
  return r;
}

function execModeStyle(mode) {
  const map = {
    "AI Execution": { fill: C.lightPurple, fontColor: C.aiPurple },
    "Automated": { fill: C.lightGreen, fontColor: C.darkGreen },
    "User Decision": { fill: C.lightAmber, fontColor: "92400E" },
    "Validation": { fill: C.lightCyan, fontColor: "155E75" },
  };
  return map[mode] || { fill: C.white, fontColor: C.textDark };
}

function severityStyle(sev) {
  const map = {
    Critical: { fill: C.criticalBg, fontColor: C.secRed },
    High: { fill: C.highBg, fontColor: C.orange },
    Medium: { fill: C.mediumBg, fontColor: C.userAmber },
    Low: { fill: C.lowBg, fontColor: C.darkGreen },
    Info: { fill: C.paleBlue, fontColor: C.tcsBlue },
  };
  return map[sev] || { fill: C.white, fontColor: C.textDark };
}

function gradeStyle(grade) {
  const map = {
    A: { fill: C.gradeABg, fontColor: C.gradeA },
    B: { fill: C.gradeBBg, fontColor: C.gradeB },
    C: { fill: C.gradeCBg, fontColor: C.gradeC },
    D: { fill: C.gradeDBg, fontColor: C.gradeD },
    F: { fill: C.gradeFBg, fontColor: C.gradeF },
  };
  return map[grade] || { fill: C.white, fontColor: C.textDark };
}

// ═══════════════════════════════════════════════════════════════
// SHEET 1: Executive Summary
// ═══════════════════════════════════════════════════════════════
const ws1 = wb.addWorksheet("Executive Summary", {
  properties: { tabColor: { argb: "FF" + C.darkNavy } },
});
setColWidths(ws1, [32, 18, 18, 18, 18]);

applyTitleBanner(
  ws1, 1, 5,
  "TCS Agentic AI — UC-04: Security & Compliance Governance",
  "Continuous security posture assessment and compliance governance using CIS benchmarks, vulnerability scanning, RBAC auditing, and policy enforcement for Kubernetes workloads."
);

let r = 4;
applySectionRow(ws1, r, 5, "USE CASE IDENTITY", C.tcsBlue);
r++;
const identity = [
  ["Use Case ID", "UC-SCG-004"],
  ["Use Case Name", "Security & Compliance Governance for Kubernetes Workloads"],
  ["Category", "Security Operations"],
  ["Platform", "TCS Agentic AI for OpenShift"],
  ["Version", "1.0"],
  ["Status", "Production Ready"],
  ["Classification", "Enterprise Security — Continuous Governance"],
];
r = addKVRows(ws1, r, 5, identity);

r++;
applySectionRow(ws1, r, 5, "DESCRIPTION", C.tcsBlue);
r++;
ws1.mergeCells(r, 1, r, 5);
const descCell = ws1.getCell(r, 1);
descCell.value =
  "This use case implements continuous security posture assessment and compliance governance " +
  "for enterprise Kubernetes environments. The AI-driven platform performs automated CIS benchmark " +
  "compliance scoring, real-time vulnerability scanning with CVSS-based prioritization, comprehensive " +
  "RBAC audit and least-privilege enforcement, OPA/Gatekeeper and Kyverno policy integration, and " +
  "Security Context Constraints (SCC) advisory. By replacing manual, periodic audits with continuous " +
  "AI-powered monitoring, organizations achieve dramatically improved detection rates, faster " +
  "remediation times, and consistently higher compliance scores.";
applyDataCell(descCell, { fill: C.paleBlue });
ws1.getRow(r).height = 80;
r += 2;

applySectionRow(ws1, r, 5, "CORE CAPABILITIES", C.navy);
r++;
const capabilities = [
  ["CIS Benchmark Compliance", "Automated CIS Kubernetes Benchmark (v5.x) scanning with 100+ checks across Pod Security, Network, RBAC, Secrets, and Image Security domains"],
  ["Vulnerability Scanning", "Continuous image vulnerability scanning with CVE database correlation, CVSS scoring, risk prioritization, and automated remediation recommendations"],
  ["RBAC Audit & Enforcement", "Deep analysis of role bindings, service accounts, privilege escalation paths, stale permissions, and least-privilege recommendations"],
  ["Policy Engine Integration", "Seamless integration with OPA/Gatekeeper, Kyverno, and OpenShift SCC for policy creation, enforcement, and violation tracking"],
  ["Compliance Reporting", "Automated compliance reports with CIS grade scoring (A-F), trend analysis, executive dashboards, and audit trail generation"],
  ["Remediation Automation", "AI-generated fix proposals with dry-run validation, one-click application, and post-remediation verification"],
];
capabilities.forEach((cap) => {
  const kCell = ws1.getCell(r, 1);
  kCell.value = cap[0];
  applyDataCell(kCell, { bold: true, fill: C.bgLight });
  ws1.mergeCells(r, 2, r, 5);
  const vCell = ws1.getCell(r, 2);
  vCell.value = cap[1];
  applyDataCell(vCell);
  ws1.getRow(r).height = 36;
  r++;
});

r++;
applySectionRow(ws1, r, 5, "SECURITY DOMAINS", C.navy);
r++;
const headers1 = ["Domain", "Checks", "AI Capability", "Detection Type", "Coverage"];
headers1.forEach((h, i) => { ws1.getCell(r, i + 1).value = h; });
applyHeaderRow(ws1, r, 5, C.tcsBlue);
r++;
const domains = [
  ["Pod Security", "25+", "Container escape detection, privilege analysis", "Real-time", "100%"],
  ["Network Policies", "15+", "Lateral movement risk, microsegmentation gaps", "Continuous", "100%"],
  ["RBAC & IAM", "20+", "Privilege escalation paths, over-permissioned accounts", "Continuous", "100%"],
  ["Secrets Management", "12+", "Unencrypted secrets, rotation compliance", "Scheduled + Event", "100%"],
  ["Image Security", "18+", "CVE correlation, base image drift, signature verification", "On-push + Scheduled", "100%"],
  ["Admission Control", "10+", "Policy bypass detection, constraint violations", "Real-time", "100%"],
];
domains.forEach((d, idx) => {
  d.forEach((val, ci) => {
    const cell = ws1.getCell(r, ci + 1);
    cell.value = val;
    applyDataCell(cell, { fill: idx % 2 === 0 ? C.white : C.bgLight, align: ci === 0 ? "left" : "center" });
  });
  ws1.getRow(r).height = 28;
  r++;
});

r++;
applySectionRow(ws1, r, 5, "EXECUTION MODE LEGEND", C.navy);
r++;
const modes = [
  ["AI Execution", C.aiPurple, C.lightPurple, "Autonomous AI analysis, pattern detection, risk scoring, remediation generation"],
  ["Automated", C.autoGreen, C.lightGreen, "System-driven scanning, policy checks, report generation, metric collection"],
  ["User Decision", C.userAmber, C.lightAmber, "Human approval for policy changes, remediation application, exception grants"],
  ["Validation", C.valCyan, C.lightCyan, "Verification of applied changes, compliance re-scanning, drift detection"],
];
modes.forEach((m) => {
  const modeCell = ws1.getCell(r, 1);
  modeCell.value = m[0];
  applyDataCell(modeCell, { bold: true, fontColor: m[1], fill: m[2] });
  ws1.mergeCells(r, 2, r, 5);
  const dCell = ws1.getCell(r, 2);
  dCell.value = m[3];
  applyDataCell(dCell);
  ws1.getRow(r).height = 26;
  r++;
});

ws1.views = [{ state: "frozen", ySplit: 2 }];

// ═══════════════════════════════════════════════════════════════
// SHEET 2: CIS Benchmark Compliance
// ═══════════════════════════════════════════════════════════════
const ws2 = wb.addWorksheet("CIS Benchmark Compliance", {
  properties: { tabColor: { argb: "FF" + C.tcsBlue } },
});
setColWidths(ws2, [14, 20, 28, 42, 14, 18, 30, 42, 18]);

applyTitleBanner(
  ws2, 1, 9,
  "CIS Kubernetes Benchmark v5.x — Compliance Checks",
  "Penalty-based scoring: 0-100 scale. Each failed check deducts points based on severity. Letter grades: A (90-100), B (80-89), C (70-79), D (60-69), F (<60)"
);

// Grading scale section
r = 4;
applySectionRow(ws2, r, 9, "COMPLIANCE GRADING SCALE", C.navy);
r++;
const gradeHeaders = ["Grade", "Score Range", "Classification", "Description", "Action Required", "", "", "", ""];
gradeHeaders.forEach((h, i) => { ws2.getCell(r, i + 1).value = h; });
applyHeaderRow(ws2, r, 9, C.tcsBlue);
// Merge empty cols for grade table
r++;
const grades = [
  ["A", "90 – 100", "Excellent", "All critical and high checks pass. Minor informational findings only.", "Maintain posture"],
  ["B", "80 – 89", "Good", "No critical failures. A few high-severity gaps with known mitigations.", "Address high findings within 30 days"],
  ["C", "70 – 79", "Acceptable", "Some high-severity failures. Compensating controls may exist.", "Remediation plan within 14 days"],
  ["D", "60 – 69", "Needs Improvement", "Multiple high-severity failures. Significant security gaps.", "Immediate remediation required"],
  ["F", "Below 60", "Critical", "Critical failures present. Cluster security is severely compromised.", "Emergency remediation — escalate immediately"],
];
grades.forEach((g) => {
  const gs = gradeStyle(g[0]);
  const gradeCell = ws2.getCell(r, 1);
  gradeCell.value = g[0];
  applyDataCell(gradeCell, { bold: true, fontColor: gs.fontColor, fill: gs.fill, align: "center", fontSize: 14 });

  ws2.getCell(r, 2).value = g[1];
  applyDataCell(ws2.getCell(r, 2), { align: "center", fill: gs.fill, fontColor: gs.fontColor, bold: true });

  ws2.getCell(r, 3).value = g[2];
  applyDataCell(ws2.getCell(r, 3), { bold: true, fill: gs.fill, fontColor: gs.fontColor });

  ws2.mergeCells(r, 4, r, 7);
  ws2.getCell(r, 4).value = g[3];
  applyDataCell(ws2.getCell(r, 4));

  ws2.mergeCells(r, 8, r, 9);
  ws2.getCell(r, 8).value = g[4];
  applyDataCell(ws2.getCell(r, 8));
  ws2.getRow(r).height = 30;
  r++;
});

// CIS Checks table
r++;
const cisHeaders = ["Check ID", "Category", "Check Name", "Description", "Severity", "Scoring Method", "Pass Criteria", "Remediation", "Execution Mode"];
cisHeaders.forEach((h, i) => { ws2.getCell(r, i + 1).value = h; });
applyHeaderRow(ws2, r, 9, C.darkNavy);
const cisHeaderRow = r;
r++;

const cisChecks = [
  // Pod Security
  { cat: "Pod Security", checks: [
    ["CIS-5.2.1", "Minimize privileged containers", "Ensure no containers run with privileged: true in the security context", "Critical", "Penalty: -15", "No pods with privileged: true", "Set securityContext.privileged: false; use specific capabilities instead", "AI Execution"],
    ["CIS-5.2.2", "Minimize host namespace sharing", "Ensure pods do not share the host process ID, IPC, or network namespace", "Critical", "Penalty: -15", "hostPID, hostIPC, hostNetwork all false", "Remove hostPID/hostIPC/hostNetwork from pod spec; use CNI networking", "AI Execution"],
    ["CIS-5.2.3", "Minimize container capabilities", "Ensure containers drop ALL capabilities and only add required ones", "High", "Penalty: -10", "capabilities.drop includes ALL", "Add securityContext.capabilities.drop: ['ALL'] and whitelist only needed caps", "Automated"],
    ["CIS-5.2.4", "Enforce Seccomp profiles", "Ensure all pods use RuntimeDefault or custom seccomp profiles", "High", "Penalty: -10", "seccompProfile.type = RuntimeDefault", "Set securityContext.seccompProfile.type: RuntimeDefault", "Automated"],
    ["CIS-5.2.5", "Enforce AppArmor profiles", "Ensure all pods have AppArmor annotations with runtime/default or custom profiles", "Medium", "Penalty: -5", "AppArmor annotation present", "Add container.apparmor.security.beta.kubernetes.io annotation", "Automated"],
    ["CIS-5.2.6", "Restrict root containers", "Ensure containers run as non-root user", "High", "Penalty: -10", "runAsNonRoot: true set", "Set securityContext.runAsNonRoot: true and specify runAsUser", "AI Execution"],
    ["CIS-5.2.7", "Restrict privilege escalation", "Ensure allowPrivilegeEscalation is set to false", "High", "Penalty: -10", "allowPrivilegeEscalation: false", "Set securityContext.allowPrivilegeEscalation: false", "Automated"],
    ["CIS-5.2.8", "Read-only root filesystem", "Ensure containers use read-only root filesystem where possible", "Medium", "Penalty: -5", "readOnlyRootFilesystem: true", "Set securityContext.readOnlyRootFilesystem: true; mount writable volumes as needed", "AI Execution"],
  ]},
  // Network Policies
  { cat: "Network Policies", checks: [
    ["CIS-5.3.1", "Default deny ingress", "Ensure a default-deny NetworkPolicy exists for ingress in each namespace", "High", "Penalty: -10", "Default deny ingress policy exists per NS", "Create NetworkPolicy with podSelector: {} and policyTypes: [Ingress] with no ingress rules", "Automated"],
    ["CIS-5.3.2", "Default deny egress", "Ensure a default-deny NetworkPolicy exists for egress in each namespace", "High", "Penalty: -10", "Default deny egress policy exists per NS", "Create NetworkPolicy with podSelector: {} and policyTypes: [Egress] with no egress rules", "Automated"],
    ["CIS-5.3.3", "Namespace isolation", "Ensure workload namespaces have network policies restricting cross-namespace traffic", "Medium", "Penalty: -5", "Cross-NS policies defined", "Define explicit ingress/egress rules limiting namespace-to-namespace communication", "AI Execution"],
    ["CIS-5.3.4", "Ingress controller security", "Ensure ingress controllers enforce TLS and proper routing rules", "High", "Penalty: -10", "TLS configured on all ingress resources", "Add tls section to Ingress resources; enforce HTTPS redirect", "AI Execution"],
    ["CIS-5.3.5", "Egress restrictions", "Ensure egress traffic is restricted to known destinations", "Medium", "Penalty: -5", "Explicit egress CIDR rules defined", "Define egress NetworkPolicy rules with specific CIDR blocks and ports", "AI Execution"],
  ]},
  // RBAC
  { cat: "RBAC", checks: [
    ["CIS-5.1.1", "Restrict cluster-admin usage", "Ensure cluster-admin role is used only where strictly required", "Critical", "Penalty: -15", "Minimal cluster-admin bindings", "Replace cluster-admin with scoped ClusterRoles; audit all ClusterRoleBindings", "AI Execution"],
    ["CIS-5.1.2", "Minimize wildcard permissions", "Ensure roles do not use wildcard (*) verbs, resources, or API groups", "Critical", "Penalty: -15", "No wildcard entries in roles", "Replace * with explicit resource names and verbs", "AI Execution"],
    ["CIS-5.1.3", "Restrict service account tokens", "Ensure automountServiceAccountToken is false for default service accounts", "High", "Penalty: -10", "automountServiceAccountToken: false", "Set automountServiceAccountToken: false on default SA; create dedicated SAs", "Automated"],
    ["CIS-5.1.4", "Minimize SA permissions", "Ensure service accounts have minimal required permissions", "High", "Penalty: -10", "SA roles scoped to namespace", "Create namespace-scoped Roles instead of ClusterRoles for SAs", "AI Execution"],
    ["CIS-5.1.5", "Audit role bindings regularly", "Ensure regular review of all RoleBindings and ClusterRoleBindings", "Medium", "Penalty: -5", "Quarterly binding audit completed", "Implement automated RBAC audit pipeline; review quarterly", "Automated"],
  ]},
  // Secrets Management
  { cat: "Secrets Management", checks: [
    ["CIS-5.4.1", "Encrypt secrets at rest", "Ensure etcd encryption provider is configured for secrets", "Critical", "Penalty: -15", "EncryptionConfiguration with aescbc/aesgcm", "Configure EncryptionConfiguration with aescbc or aesgcm provider for secrets", "Automated"],
    ["CIS-5.4.2", "Secret rotation policy", "Ensure secrets are rotated on a defined schedule", "High", "Penalty: -10", "Rotation within 90 days", "Implement automated rotation using external-secrets-operator or Vault", "AI Execution"],
    ["CIS-5.4.3", "External secret stores", "Ensure sensitive credentials use external secret management (Vault, AWS SM)", "High", "Penalty: -10", "ExternalSecret CRDs in use", "Deploy external-secrets-operator; migrate secrets to Vault/AWS Secrets Manager", "AI Execution"],
    ["CIS-5.4.4", "Restrict secret access", "Ensure RBAC restricts who can read secrets in each namespace", "High", "Penalty: -10", "Secret access limited to required SAs", "Create specific Roles granting get/list on secrets only to designated SAs", "Automated"],
  ]},
  // Image Security
  { cat: "Image Security", checks: [
    ["CIS-5.5.1", "Enforce image signing", "Ensure only signed container images are allowed to run", "Critical", "Penalty: -15", "Image signature verification enabled", "Enable image signature verification via Cosign/Sigstore; block unsigned images", "Automated"],
    ["CIS-5.5.2", "Vulnerability thresholds", "Ensure images with critical/high CVEs are blocked from deployment", "Critical", "Penalty: -15", "No critical CVEs; high CVEs < 5", "Configure admission webhook to reject images exceeding CVE thresholds", "AI Execution"],
    ["CIS-5.5.3", "Base image currency", "Ensure base images are updated within defined freshness windows", "High", "Penalty: -10", "Base image < 30 days old", "Implement automated base image rebuild pipeline; track image age", "Automated"],
    ["CIS-5.5.4", "Registry restrictions", "Ensure images are pulled only from approved registries", "High", "Penalty: -10", "AllowedRegistries policy enforced", "Configure OPA/Kyverno policy to restrict image registries to approved list", "Automated"],
    ["CIS-5.5.5", "Image tag immutability", "Ensure mutable tags like 'latest' are not used in production", "Medium", "Penalty: -5", "No :latest or untagged images", "Enforce digest-based or semver-tagged image references in all deployments", "AI Execution"],
  ]},
];

cisChecks.forEach((catGroup) => {
  applySectionRow(ws2, r, 9, catGroup.cat.toUpperCase(), C.tcsBlue);
  r++;
  catGroup.checks.forEach((chk, idx) => {
    const row = [chk[0], catGroup.cat, ...chk.slice(1)];
    row.forEach((val, ci) => {
      const cell = ws2.getCell(r, ci + 1);
      cell.value = val;
      const base = { fill: idx % 2 === 0 ? C.white : C.bgLight };
      // Severity column (index 4)
      if (ci === 4) {
        const ss = severityStyle(val);
        applyDataCell(cell, { bold: true, fontColor: ss.fontColor, fill: ss.fill, align: "center" });
      }
      // Execution Mode column (index 8)
      else if (ci === 8) {
        const es = execModeStyle(val);
        applyDataCell(cell, { bold: true, fontColor: es.fontColor, fill: es.fill, align: "center" });
      }
      else {
        applyDataCell(cell, base);
      }
    });
    ws2.getRow(r).height = 40;
    r++;
  });
});

ws2.views = [{ state: "frozen", ySplit: cisHeaderRow }];

// ═══════════════════════════════════════════════════════════════
// SHEET 3: Vulnerability Scanning Workflow
// ═══════════════════════════════════════════════════════════════
const ws3 = wb.addWorksheet("Vuln Scanning Workflow", {
  properties: { tabColor: { argb: "FF" + C.aiPurple } },
});
setColWidths(ws3, [10, 20, 32, 18, 50, 42]);

applyTitleBanner(
  ws3, 1, 6,
  "Vulnerability Scanning Workflow — End-to-End Pipeline",
  "Comprehensive 24-step workflow covering image discovery through remediation verification. Each step shows execution mode, detailed actions, and traditional manual equivalent."
);

r = 4;
const vulnHeaders = ["Step #", "Phase", "Action", "Execution Mode", "Details", "Manual Equivalent"];
vulnHeaders.forEach((h, i) => { ws3.getCell(r, i + 1).value = h; });
applyHeaderRow(ws3, r, 6, C.darkNavy);
const vulnHeaderRow = r;
r++;

const vulnSteps = [
  // Phase 1: Discovery
  ["1", "Discovery", "Cluster Image Inventory", "Automated", "Enumerate all running container images across all namespaces using Kubernetes API. Catalog image:tag, digest, registry source, and deployment association.", "kubectl get pods -A -o jsonpath for images; manual spreadsheet tracking"],
  ["2", "Discovery", "Registry Authentication", "Automated", "Establish authenticated sessions with all configured container registries (Quay, Docker Hub, ECR, ACR, GCR) for image metadata retrieval.", "Manual registry login; credential management across multiple registries"],
  ["3", "Discovery", "Image Manifest Analysis", "AI Execution", "Parse image manifests to extract layer information, base image lineage, build timestamps, and software bill of materials (SBOM).", "Manual image inspection with skopeo/crane; no automated SBOM extraction"],
  ["4", "Discovery", "Dependency Tree Mapping", "AI Execution", "Build complete dependency graph for each image including OS packages, language libraries, and transitive dependencies.", "Manually running syft/trivy on each image; no cross-image correlation"],

  // Phase 2: Scanning
  ["5", "Scanning", "CVE Database Synchronization", "Automated", "Sync latest CVE feeds from NVD, MITRE, vendor advisories (RHSA, GHSA), and exploit databases. Maintain local cache for offline scanning.", "Manual database updates; often outdated between scan cycles"],
  ["6", "Scanning", "Multi-Scanner Execution", "Automated", "Execute parallel vulnerability scans using multiple engines (Trivy, Grype, Clair) for comprehensive coverage and cross-validation.", "Running single scanner manually; no cross-validation between tools"],
  ["7", "Scanning", "CVSS Score Calculation", "AI Execution", "Calculate CVSS v3.1 base, temporal, and environmental scores. Apply organization-specific environmental metrics for contextualized severity.", "Using base CVSS scores only; no environmental context adjustment"],
  ["8", "Scanning", "False Positive Analysis", "AI Execution", "AI analyzes scan results against runtime context, reachability analysis, and exploit path viability to filter false positives.", "Manual triage of every finding; high false positive rate causes alert fatigue"],
  ["9", "Scanning", "Exploitability Assessment", "AI Execution", "Cross-reference CVEs with CISA KEV catalog, Exploit-DB, and threat intelligence feeds to determine active exploitation status.", "Checking CISA KEV manually; often missed for non-critical CVEs"],

  // Phase 3: Risk Assessment
  ["10", "Risk Assessment", "Contextual Risk Scoring", "AI Execution", "Calculate composite risk score factoring CVSS, exploitability, network exposure, data sensitivity, and blast radius.", "Prioritizing by CVSS alone; no context about actual deployment risk"],
  ["11", "Risk Assessment", "Blast Radius Analysis", "AI Execution", "Map vulnerable components to dependent services, assess lateral movement potential, and quantify impact scope.", "No automated blast radius analysis; relies on tribal knowledge"],
  ["12", "Risk Assessment", "Compliance Impact Assessment", "AI Execution", "Evaluate how vulnerabilities affect CIS benchmark compliance, PCI-DSS, SOC2, and organizational security policies.", "Manual cross-referencing with compliance frameworks"],
  ["13", "Risk Assessment", "Priority Queue Generation", "AI Execution", "Generate prioritized remediation queue based on composite risk, SLA requirements, and available fix versions.", "Manual priority spreadsheets; subjective and inconsistent prioritization"],

  // Phase 4: Remediation
  ["14", "Remediation", "Fix Version Discovery", "Automated", "Identify available patched versions for each vulnerable package. Map upgrade paths and detect breaking changes.", "Searching vendor advisories and changelogs manually"],
  ["15", "Remediation", "Remediation Plan Generation", "AI Execution", "Generate detailed remediation plan including image rebuild instructions, Dockerfile patches, and dependency updates.", "Writing remediation tickets manually; inconsistent detail level"],
  ["16", "Remediation", "Compatibility Analysis", "AI Execution", "Analyze proposed fixes for compatibility with existing application code, API contracts, and integration dependencies.", "Manual testing in dev environment; often skipped under time pressure"],
  ["17", "Remediation", "Fix Proposal Review", "User Decision", "Present remediation proposals to security team with risk context, fix details, and estimated impact for approval.", "Email chains and meetings for approval; slow decision cycles"],
  ["18", "Remediation", "Automated Patching", "Automated", "Apply approved patches through CI/CD pipeline: rebuild images, push to registry, update deployment manifests.", "Manual image rebuild, registry push, and deployment update"],

  // Phase 5: Verification
  ["19", "Verification", "Post-Patch Scanning", "Automated", "Re-scan patched images to verify all targeted vulnerabilities are resolved and no new issues introduced.", "Re-running manual scans; often delayed or forgotten"],
  ["20", "Verification", "Deployment Validation", "Validation", "Verify patched images deploy successfully, pass health checks, and maintain functional correctness.", "Manual deployment monitoring; reactive issue detection"],
  ["21", "Verification", "Regression Testing", "Automated", "Execute automated security regression tests to ensure patches don't reintroduce previously fixed vulnerabilities.", "No automated regression; relies on next scheduled scan"],
  ["22", "Verification", "Compliance Re-scoring", "Validation", "Recalculate CIS compliance scores and vulnerability metrics to reflect remediated state.", "Manual report regeneration; often shows stale data"],
  ["23", "Verification", "Audit Trail Generation", "Automated", "Create immutable audit log capturing scan results, decisions, approvals, actions taken, and verification outcomes.", "Manual documentation in wiki/tickets; incomplete audit trail"],
  ["24", "Verification", "Continuous Monitoring Activation", "Automated", "Enable continuous runtime monitoring for remediated CVEs to detect regression or reintroduction.", "Waiting for next scheduled scan cycle; no continuous monitoring"],
];

vulnSteps.forEach((step, idx) => {
  step.forEach((val, ci) => {
    const cell = ws3.getCell(r, ci + 1);
    cell.value = val;
    if (ci === 0) {
      applyDataCell(cell, { align: "center", bold: true, fill: idx % 2 === 0 ? C.white : C.bgLight });
    } else if (ci === 3) {
      const es = execModeStyle(val);
      applyDataCell(cell, { bold: true, fontColor: es.fontColor, fill: es.fill, align: "center" });
    } else {
      applyDataCell(cell, { fill: idx % 2 === 0 ? C.white : C.bgLight });
    }
  });
  ws3.getRow(r).height = 50;
  r++;
});

ws3.views = [{ state: "frozen", ySplit: vulnHeaderRow }];

// ═══════════════════════════════════════════════════════════════
// SHEET 4: RBAC Audit
// ═══════════════════════════════════════════════════════════════
const ws4 = wb.addWorksheet("RBAC Audit", {
  properties: { tabColor: { argb: "FF" + C.secRed } },
});
setColWidths(ws4, [12, 22, 32, 14, 18, 42, 36, 18]);

applyTitleBanner(
  ws4, 1, 8,
  "RBAC Audit — Role-Based Access Control Security Analysis",
  "Comprehensive RBAC analysis covering service accounts, role bindings, privilege escalation detection, least-privilege recommendations, and stale permission cleanup."
);

r = 4;
const rbacHeaders = ["Audit ID", "Category", "Check Name", "Severity", "Execution Mode", "Description", "Recommendation", "Frequency"];
rbacHeaders.forEach((h, i) => { ws4.getCell(r, i + 1).value = h; });
applyHeaderRow(ws4, r, 8, C.darkNavy);
const rbacHeaderRow = r;
r++;

const rbacData = [
  // Service Account Analysis
  { cat: "Service Account Analysis", items: [
    ["RBAC-SA-01", "Default SA Usage Audit", "Critical", "AI Execution", "Identify pods using default service accounts instead of dedicated ones. Default SAs often have excessive permissions.", "Create dedicated SAs per workload with minimal required permissions", "Continuous"],
    ["RBAC-SA-02", "SA Token Auto-mount Check", "High", "Automated", "Detect service accounts with automountServiceAccountToken: true when API access is not required.", "Set automountServiceAccountToken: false on unused SAs", "Daily"],
    ["RBAC-SA-03", "Orphaned SA Detection", "Medium", "Automated", "Find service accounts not referenced by any pod, deployment, or job — potential cleanup targets.", "Remove orphaned SAs after 30-day grace period with no activity", "Weekly"],
    ["RBAC-SA-04", "SA Secret Enumeration", "High", "AI Execution", "Map all secrets associated with each service account. Identify SAs with access to sensitive secrets.", "Restrict SA-secret bindings to minimum required; audit cross-NS access", "Daily"],
    ["RBAC-SA-05", "SA Namespace Scope Audit", "High", "AI Execution", "Detect service accounts with cross-namespace permissions that violate isolation boundaries.", "Restrict SAs to namespace scope; use separate SAs for cross-NS needs", "Weekly"],
  ]},
  // Role Binding Review
  { cat: "Role Binding Review", items: [
    ["RBAC-RB-01", "ClusterRoleBinding Audit", "Critical", "AI Execution", "Review all ClusterRoleBindings for overly permissive cluster-wide access grants.", "Replace ClusterRoleBindings with namespace-scoped RoleBindings where possible", "Daily"],
    ["RBAC-RB-02", "Wildcard Permission Check", "Critical", "AI Execution", "Detect roles using wildcards in verbs, resources, or API groups — equivalent to full admin access.", "Replace wildcards with explicit resource and verb lists", "Continuous"],
    ["RBAC-RB-03", "Binding Subject Validation", "High", "Automated", "Verify all binding subjects (users, groups, SAs) exist and are active. Flag bindings to deleted subjects.", "Remove bindings to non-existent subjects; implement binding lifecycle management", "Daily"],
    ["RBAC-RB-04", "Role Aggregation Analysis", "Medium", "AI Execution", "Analyze aggregated ClusterRoles for unintended permission accumulation through label-based aggregation.", "Review aggregation labels; ensure combined permissions match intent", "Weekly"],
    ["RBAC-RB-05", "Namespace Admin Review", "High", "AI Execution", "Identify users/SAs with admin-equivalent access in namespaces holding sensitive workloads.", "Implement approval workflow for namespace admin grants; review quarterly", "Weekly"],
  ]},
  // Privilege Escalation Detection
  { cat: "Privilege Escalation Detection", items: [
    ["RBAC-PE-01", "Escalate Verb Detection", "Critical", "AI Execution", "Detect roles granting 'escalate' verb which allows creating roles with higher privileges than the creator.", "Remove escalate verb; use admission webhooks to prevent privilege escalation", "Continuous"],
    ["RBAC-PE-02", "Bind Verb Analysis", "Critical", "AI Execution", "Identify roles with 'bind' verb on roles/clusterroles — allows binding to any role including cluster-admin.", "Restrict bind verb to specific role names using resourceNames field", "Continuous"],
    ["RBAC-PE-03", "Impersonation Permission Check", "Critical", "AI Execution", "Detect roles allowing user/group/SA impersonation — can bypass all RBAC restrictions.", "Remove impersonate verb; grant only to auditing/debugging service accounts", "Continuous"],
    ["RBAC-PE-04", "Pod Create + SA Mount Path", "High", "AI Execution", "Identify attack path: users who can create pods can mount any SA token, inheriting SA permissions.", "Restrict pod creation to CI/CD SAs; enforce PodSecurity admission", "Daily"],
    ["RBAC-PE-05", "Secret Read Escalation", "High", "AI Execution", "Detect users who can read secrets in kube-system — can extract SA tokens for privilege escalation.", "Restrict secret read access in system namespaces to dedicated audit SAs", "Daily"],
  ]},
  // Least Privilege Recommendations
  { cat: "Least Privilege Recommendations", items: [
    ["RBAC-LP-01", "Permission Usage Analysis", "Medium", "AI Execution", "Analyze audit logs to determine which RBAC permissions are actually used vs. granted. Calculate usage ratio.", "Reduce roles to only permissions observed in use over 90-day window", "Monthly"],
    ["RBAC-LP-02", "Role Consolidation", "Low", "AI Execution", "Identify duplicate or near-duplicate roles that can be consolidated to reduce management complexity.", "Merge similar roles; standardize on role templates per workload type", "Monthly"],
    ["RBAC-LP-03", "Time-Bound Access Review", "Medium", "AI Execution", "Identify permanently granted elevated permissions that should be time-bound or just-in-time.", "Implement JIT access for elevated permissions; use TTL-based bindings", "Weekly"],
    ["RBAC-LP-04", "Cross-Namespace Access Minimization", "High", "AI Execution", "Map all cross-namespace access patterns and recommend isolation improvements.", "Implement network policies alongside RBAC; minimize cross-NS service accounts", "Monthly"],
  ]},
  // Stale Permission Cleanup
  { cat: "Stale Permission Cleanup", items: [
    ["RBAC-SC-01", "Inactive User Binding Cleanup", "Medium", "Automated", "Identify role bindings for users who haven't authenticated in 90+ days.", "Revoke bindings for inactive users; notify before removal", "Weekly"],
    ["RBAC-SC-02", "Deprecated API Group Cleanup", "Low", "Automated", "Find roles referencing deprecated or removed API groups/resources.", "Update roles to current API groups; remove references to non-existent resources", "Monthly"],
    ["RBAC-SC-03", "Unused ClusterRole Identification", "Low", "Automated", "Detect ClusterRoles not referenced by any binding — orphaned role definitions.", "Archive and remove after confirmation; maintain cleanup audit log", "Monthly"],
    ["RBAC-SC-04", "Stale Token Rotation", "High", "Automated", "Identify SA tokens older than rotation policy threshold (default: 90 days).", "Enable automatic token rotation; configure BoundServiceAccountTokenVolume", "Daily"],
  ]},
];

rbacData.forEach((catGroup) => {
  applySectionRow(ws4, r, 8, catGroup.cat.toUpperCase(), C.tcsBlue);
  r++;
  catGroup.items.forEach((item, idx) => {
    const row = [item[0], catGroup.cat, ...item.slice(1)];
    row.forEach((val, ci) => {
      const cell = ws4.getCell(r, ci + 1);
      cell.value = val;
      if (ci === 3) { // Severity
        const ss = severityStyle(val);
        applyDataCell(cell, { bold: true, fontColor: ss.fontColor, fill: ss.fill, align: "center" });
      } else if (ci === 4) { // Execution Mode
        const es = execModeStyle(val);
        applyDataCell(cell, { bold: true, fontColor: es.fontColor, fill: es.fill, align: "center" });
      } else if (ci === 7) { // Frequency
        applyDataCell(cell, { align: "center", fill: idx % 2 === 0 ? C.white : C.bgLight });
      } else {
        applyDataCell(cell, { fill: idx % 2 === 0 ? C.white : C.bgLight });
      }
    });
    ws4.getRow(r).height = 44;
    r++;
  });
});

ws4.views = [{ state: "frozen", ySplit: rbacHeaderRow }];

// ═══════════════════════════════════════════════════════════════
// SHEET 5: Policy Engine Integration
// ═══════════════════════════════════════════════════════════════
const ws5 = wb.addWorksheet("Policy Engine Integration", {
  properties: { tabColor: { argb: "FF" + C.autoGreen } },
});
setColWidths(ws5, [14, 22, 30, 14, 18, 42, 30, 18]);

applyTitleBanner(
  ws5, 1, 8,
  "Policy Engine Integration — OPA, Kyverno & SCC Governance",
  "Unified policy management across Gatekeeper/OPA, Kyverno, and OpenShift Security Context Constraints with AI-driven policy creation, enforcement, and violation tracking."
);

r = 4;
const policyHeaders = ["Policy ID", "Engine", "Policy Name", "Severity", "Execution Mode", "Description", "Violation Response", "Status"];
policyHeaders.forEach((h, i) => { ws5.getCell(r, i + 1).value = h; });
applyHeaderRow(ws5, r, 8, C.darkNavy);
const policyHeaderRow = r;
r++;

const policyData = [
  // Gatekeeper/OPA
  { cat: "Gatekeeper / OPA Integration", items: [
    ["GK-POL-01", "Gatekeeper", "Privileged Container Deny", "Critical", "Automated", "ConstraintTemplate that denies any pod with privileged: true. Enforced cluster-wide with namespace exemptions for system components.", "Deny admission; log violation with pod details and requesting user", "Enforcing"],
    ["GK-POL-02", "Gatekeeper", "Required Labels Enforcement", "Medium", "Automated", "Ensure all deployments have required labels (app, owner, team, environment) for governance and cost tracking.", "Deny admission; return list of missing required labels", "Enforcing"],
    ["GK-POL-03", "Gatekeeper", "Image Registry Allowlist", "High", "Automated", "Restrict container images to approved registries only. Blocks images from unknown or untrusted sources.", "Deny admission; log blocked registry and suggest approved alternatives", "Enforcing"],
    ["GK-POL-04", "Gatekeeper", "Resource Limits Required", "High", "Automated", "Require CPU and memory limits on all containers to prevent resource exhaustion and noisy neighbor issues.", "Deny admission; return container names missing resource limits", "Enforcing"],
    ["GK-POL-05", "Gatekeeper", "Host Path Volume Restriction", "Critical", "Automated", "Block hostPath volume mounts that could expose host filesystem to containers.", "Deny admission; suggest PVC-based alternatives for persistent storage", "Enforcing"],
    ["GK-POL-06", "Gatekeeper", "External IP Restriction", "High", "AI Execution", "AI-monitored policy that restricts Service externalIPs to prevent IP hijacking attacks (CVE-2020-8554).", "Deny admission; alert security team; log attempted external IP assignment", "Enforcing"],
  ]},
  // Kyverno
  { cat: "Kyverno Policy Support", items: [
    ["KV-POL-01", "Kyverno", "Auto-inject Network Policies", "High", "Automated", "ClusterPolicy that automatically generates default-deny NetworkPolicies for new namespaces.", "Generate: create default-deny NetworkPolicy in new namespace", "Active"],
    ["KV-POL-02", "Kyverno", "Image Tag Mutation", "Medium", "Automated", "Mutate pods using :latest tag to use digest-based references. Resolves tag to current digest at admission.", "Mutate: replace :latest with resolved image digest", "Active"],
    ["KV-POL-03", "Kyverno", "Pod Security Standards", "High", "Automated", "Validate pods against Kubernetes Pod Security Standards (restricted profile) with automatic exception handling.", "Deny or Audit based on namespace label; generate detailed violation report", "Active"],
    ["KV-POL-04", "Kyverno", "Secret Generation", "Medium", "Automated", "Auto-generate required secrets (TLS certs, registry pull secrets) when new namespaces are created.", "Generate: create TLS secret and imagePullSecret in new namespace", "Active"],
    ["KV-POL-05", "Kyverno", "Deprecated API Detection", "Low", "AI Execution", "AI-enhanced policy that detects use of deprecated Kubernetes APIs and suggests migration paths.", "Audit: log deprecated API usage; generate migration report with replacements", "Audit"],
    ["KV-POL-06", "Kyverno", "Label Propagation", "Low", "Automated", "Automatically propagate labels from namespace to all child resources for consistent governance.", "Mutate: add namespace labels to pods, services, deployments", "Active"],
  ]},
  // SCC
  { cat: "SCC (Security Context Constraints) Advisor", items: [
    ["SCC-ADV-01", "SCC", "SCC Assignment Analysis", "High", "AI Execution", "Analyze which SCCs are assigned to each service account and whether they are more permissive than required.", "Generate SCC right-sizing recommendations per workload", "Monitoring"],
    ["SCC-ADV-02", "SCC", "Restricted SCC Enforcement", "Critical", "Automated", "Ensure all non-system workloads use 'restricted' SCC unless explicitly exempted with approval.", "Block deployment; require SCC exception request with justification", "Enforcing"],
    ["SCC-ADV-03", "SCC", "Custom SCC Validation", "High", "AI Execution", "AI reviews custom SCCs for overly permissive configurations and suggests least-privilege alternatives.", "Generate custom SCC audit report with specific tightening recommendations", "Monitoring"],
    ["SCC-ADV-04", "SCC", "SCC Drift Detection", "Medium", "Automated", "Monitor for unauthorized SCC changes and alert when SCCs are modified outside change management process.", "Alert: notify security team; generate diff of SCC changes", "Active"],
    ["SCC-ADV-05", "SCC", "SCC Migration Advisor", "Medium", "AI Execution", "Guide migration from anyuid/privileged SCCs to restricted SCC with workload-specific recommendations.", "Generate step-by-step migration plan with testing checkpoints", "Advisory"],
  ]},
  // Custom Policy
  { cat: "Custom Policy Creation", items: [
    ["CP-POL-01", "Custom", "Natural Language Policy Builder", "Info", "AI Execution", "AI converts natural language security requirements into OPA Rego or Kyverno YAML policies.", "Generate: create policy YAML/Rego from natural language description", "Available"],
    ["CP-POL-02", "Custom", "Policy Testing Framework", "Medium", "Automated", "Automated policy testing with synthetic admission requests to validate policy behavior before deployment.", "Run test suite; report pass/fail with detailed assertion results", "Available"],
    ["CP-POL-03", "Custom", "Policy Impact Simulation", "High", "AI Execution", "Dry-run new policies against existing cluster state to predict which resources would be affected.", "Generate impact report: affected resources, namespaces, workload owners", "Available"],
    ["CP-POL-04", "Custom", "Policy Version Management", "Low", "Automated", "GitOps-integrated policy versioning with rollback capability and change audit trail.", "Track policy changes in Git; enable one-click rollback to previous version", "Active"],
  ]},
  // Violation Tracking
  { cat: "Policy Violation Tracking & Remediation", items: [
    ["VT-POL-01", "Multi-Engine", "Centralized Violation Dashboard", "Info", "Automated", "Aggregate violations from Gatekeeper, Kyverno, and SCC into unified dashboard with filtering and search.", "Display: real-time violation feed with severity, policy, resource, namespace", "Active"],
    ["VT-POL-02", "Multi-Engine", "Violation Trend Analysis", "Medium", "AI Execution", "AI analyzes violation trends to identify recurring issues, problematic teams, and systemic policy gaps.", "Generate: weekly trend report with root cause analysis and recommendations", "Active"],
    ["VT-POL-03", "Multi-Engine", "Auto-Remediation Engine", "High", "AI Execution", "AI generates and proposes remediation patches for common violations with one-click application.", "Generate: YAML patch for violation; present for user approval before applying", "Available"],
    ["VT-POL-04", "Multi-Engine", "Violation SLA Tracking", "Medium", "Automated", "Track time-to-remediation against defined SLAs per severity level. Escalate overdue violations.", "Alert: escalate to security lead when SLA is breached; generate overdue report", "Active"],
    ["VT-POL-05", "Multi-Engine", "Exception Management", "High", "User Decision", "Formal exception workflow for policy violations requiring business justification and time-bound approval.", "Require: justification, approver, expiry date, compensating controls documentation", "Active"],
  ]},
];

policyData.forEach((catGroup) => {
  applySectionRow(ws5, r, 8, catGroup.cat.toUpperCase(), C.tcsBlue);
  r++;
  catGroup.items.forEach((item, idx) => {
    const row = [item[0], catGroup.cat, ...item.slice(1)];
    row.forEach((val, ci) => {
      const cell = ws5.getCell(r, ci + 1);
      cell.value = val;
      if (ci === 3) {
        const ss = severityStyle(val);
        applyDataCell(cell, { bold: true, fontColor: ss.fontColor, fill: ss.fill, align: "center" });
      } else if (ci === 4) {
        const es = execModeStyle(val);
        applyDataCell(cell, { bold: true, fontColor: es.fontColor, fill: es.fill, align: "center" });
      } else if (ci === 7) {
        applyDataCell(cell, { align: "center", bold: true, fill: idx % 2 === 0 ? C.white : C.bgLight });
      } else {
        applyDataCell(cell, { fill: idx % 2 === 0 ? C.white : C.bgLight });
      }
    });
    ws4.getRow(r).height; // force row
    ws5.getRow(r).height = 44;
    r++;
  });
});

ws5.views = [{ state: "frozen", ySplit: policyHeaderRow }];

// ═══════════════════════════════════════════════════════════════
// SHEET 6: Manual vs Automated Comparison
// ═══════════════════════════════════════════════════════════════
const ws6 = wb.addWorksheet("Manual vs Automated", {
  properties: { tabColor: { argb: "FF" + C.userAmber } },
});
setColWidths(ws6, [28, 36, 36, 18, 18, 24]);

applyTitleBanner(
  ws6, 1, 6,
  "Manual Security Audit vs TCS Agentic AI — Comparison",
  "Side-by-side comparison of traditional manual security audit processes versus AI-driven continuous security governance."
);

r = 4;
applySectionRow(ws6, r, 6, "OVERALL COMPARISON", C.navy);
r++;
const compHeaders = ["Security Dimension", "Traditional Manual Approach", "TCS Agentic AI Approach", "Manual Effort", "AI Effort", "Improvement"];
compHeaders.forEach((h, i) => { ws6.getCell(r, i + 1).value = h; });
applyHeaderRow(ws6, r, 6, C.darkNavy);
r++;

const comparisons = [
  ["Audit Frequency", "Quarterly or annual scheduled audits; compliance checks before major releases", "Continuous real-time scanning with event-driven triggers; every deployment checked", "1-2 weeks per audit", "Always-on", "From quarterly to continuous"],
  ["CIS Benchmark Coverage", "Partial coverage; manual checklist review of selected benchmarks", "100% CIS benchmark coverage; all 100+ checks automated with penalty scoring", "40-60% coverage", "100% coverage", "40-60% increase in coverage"],
  ["Vulnerability Detection", "Periodic scans (weekly/monthly); single scanner; no runtime context", "Multi-scanner continuous scanning with AI false-positive filtering and risk context", "Days to detect", "Minutes to detect", "Detection time: days to minutes"],
  ["Detection Accuracy", "High false positive rate (30-50%); manual triage required for each finding", "AI-filtered results with reachability analysis; <5% false positive rate", "50-70% accuracy", "95%+ accuracy", "Accuracy improved to 95%+"],
  ["RBAC Analysis", "Spreadsheet-based review of role bindings; no privilege escalation path analysis", "Automated graph analysis of all RBAC paths; AI privilege escalation detection", "2-3 days per cluster", "Real-time", "Continuous vs periodic review"],
  ["Policy Compliance", "Manual policy review against documentation; inconsistent enforcement", "Automated policy enforcement with OPA/Kyverno; real-time violation tracking", "Variable enforcement", "100% enforcement", "Consistent policy enforcement"],
  ["Response to New CVEs", "Wait for next scan cycle; manual assessment of impact across clusters", "Immediate notification with AI impact assessment and remediation recommendations", "3-7 days average", "< 15 minutes", "Response time: days to minutes"],
  ["Remediation Workflow", "Manual ticket creation; email-based approval; hand-crafted patches", "AI-generated fix proposals with dry-run; one-click apply; automated verification", "Hours per finding", "Minutes per finding", "Remediation time reduced 90%+"],
  ["Compliance Reporting", "Manual report generation from multiple tools; often stale by publication", "Real-time compliance dashboards; automated report generation with current data", "2-5 days to compile", "Instant", "Real-time vs days-old reports"],
  ["Audit Trail", "Scattered across tickets, wikis, emails; incomplete and hard to correlate", "Immutable centralized audit log with full chain of custody for every action", "Incomplete trail", "Complete trail", "Full audit traceability"],
  ["Scalability", "Linear effort increase per cluster; does not scale beyond 5-10 clusters", "Scales to hundreds of clusters with consistent quality and speed", "O(n) effort", "O(1) effort", "Linear to constant scaling"],
  ["Institutional Knowledge", "Relies on senior SRE expertise; knowledge lost with turnover", "AI captures and applies security patterns; consistent regardless of team changes", "High key-person risk", "Knowledge retained", "Eliminates key-person dependency"],
];

comparisons.forEach((row, idx) => {
  row.forEach((val, ci) => {
    const cell = ws6.getCell(r, ci + 1);
    cell.value = val;
    if (ci === 0) {
      applyDataCell(cell, { bold: true, fill: C.bgLight });
    } else if (ci === 1) {
      applyDataCell(cell, { fill: C.lightRed, fontColor: C.secRed });
    } else if (ci === 2) {
      applyDataCell(cell, { fill: C.lightGreen, fontColor: C.darkGreen });
    } else if (ci === 3) {
      applyDataCell(cell, { align: "center", fill: C.lightRed, fontColor: C.secRed, bold: true });
    } else if (ci === 4) {
      applyDataCell(cell, { align: "center", fill: C.lightGreen, fontColor: C.darkGreen, bold: true });
    } else {
      applyDataCell(cell, { fill: C.lightBlue, fontColor: C.tcsBlue, bold: true });
    }
  });
  ws6.getRow(r).height = 50;
  r++;
});

// Per-Domain Comparison
r += 2;
applySectionRow(ws6, r, 6, "DOMAIN-SPECIFIC COMPARISON", C.navy);
r++;
const domCompHeaders = ["Security Domain", "Manual Method", "AI-Driven Method", "Manual Time", "AI Time", "Quality Gain"];
domCompHeaders.forEach((h, i) => { ws6.getCell(r, i + 1).value = h; });
applyHeaderRow(ws6, r, 6, C.tcsBlue);
r++;

const domainComps = [
  ["Pod Security", "Manual kubectl describe; visual inspection of pod specs for security context settings", "Automated pod spec analysis against CIS 5.2.x; AI flags privilege escalation combinations", "4-6 hrs/cluster", "< 2 min", "Finds multi-field escalation patterns humans miss"],
  ["Network Policies", "Manual review of NetworkPolicy YAML; no topology-aware gap analysis", "AI maps network topology and identifies unprotected lateral movement paths", "8-12 hrs/cluster", "< 5 min", "Complete topology-aware coverage vs spot checks"],
  ["RBAC Security", "Export bindings to CSV; manual review of role permissions against expectations", "Graph-based RBAC analysis with AI privilege escalation path detection", "2-3 days/cluster", "< 10 min", "Detects escalation chains humans cannot trace manually"],
  ["Secrets Management", "Check etcd encryption config; manual review of secret access patterns", "Continuous encryption verification; AI-driven rotation compliance and access anomaly detection", "6-8 hrs/cluster", "Real-time", "Catches encryption gaps and rotation violations instantly"],
  ["Image Security", "Run trivy/grype manually; review each CVE in spreadsheet", "Multi-scanner with AI dedup, false positive filtering, and contextual risk scoring", "1-2 days/cluster", "< 15 min", "Context-aware prioritization vs raw CVSS sorting"],
  ["Admission Control", "Review OPA/Kyverno policies manually; test with sample requests", "AI validates policy completeness, simulates bypass scenarios, monitors violations", "1-2 days", "Continuous", "Proactive bypass detection vs reactive discovery"],
];

domainComps.forEach((row, idx) => {
  row.forEach((val, ci) => {
    const cell = ws6.getCell(r, ci + 1);
    cell.value = val;
    if (ci === 0) {
      applyDataCell(cell, { bold: true, fill: C.bgLight });
    } else if (ci === 1) {
      applyDataCell(cell, { fill: idx % 2 === 0 ? C.white : C.bgLight });
    } else if (ci === 2) {
      applyDataCell(cell, { fill: idx % 2 === 0 ? C.white : C.bgLight });
    } else if (ci === 3) {
      applyDataCell(cell, { align: "center", fill: C.lightRed, fontColor: C.secRed, bold: true });
    } else if (ci === 4) {
      applyDataCell(cell, { align: "center", fill: C.lightGreen, fontColor: C.darkGreen, bold: true });
    } else {
      applyDataCell(cell, { fill: C.lightBlue, fontColor: C.tcsBlue });
    }
  });
  ws6.getRow(r).height = 50;
  r++;
});

ws6.views = [{ state: "frozen", ySplit: 5 }];

// ═══════════════════════════════════════════════════════════════
// SHEET 7: Impact Metrics
// ═══════════════════════════════════════════════════════════════
const ws7 = wb.addWorksheet("Impact Metrics", {
  properties: { tabColor: { argb: "FF" + C.autoGreen } },
});
setColWidths(ws7, [30, 22, 22, 22, 28, 36]);

applyTitleBanner(
  ws7, 1, 6,
  "Impact Metrics — Security & Compliance Governance Outcomes",
  "Measurable improvements from implementing TCS Agentic AI Security & Compliance Governance across enterprise Kubernetes environments."
);

r = 4;
applySectionRow(ws7, r, 6, "COMPLIANCE SCORE IMPROVEMENT", C.navy);
r++;
const metricHeaders = ["Metric", "Before (Manual)", "After (AI-Driven)", "Improvement", "Measurement Method", "Notes"];
metricHeaders.forEach((h, i) => { ws7.getCell(r, i + 1).value = h; });
applyHeaderRow(ws7, r, 6, C.darkNavy);
r++;

const complianceMetrics = [
  ["Overall CIS Compliance Score", "62% (Grade D)", "94% (Grade A)", "+32 percentage points", "Weighted CIS benchmark score across all domains", "Measured across 100+ CIS checks"],
  ["Pod Security Score", "58% (Grade F)", "96% (Grade A)", "+38 percentage points", "CIS 5.2.x Pod Security checks", "Largest improvement area due to AI privilege detection"],
  ["Network Policy Score", "55% (Grade F)", "91% (Grade A)", "+36 percentage points", "CIS 5.3.x Network Policy checks", "AI identifies microsegmentation gaps"],
  ["RBAC Security Score", "65% (Grade D)", "93% (Grade A)", "+28 percentage points", "CIS 5.1.x RBAC checks", "Escalation path detection is key differentiator"],
  ["Secrets Management Score", "70% (Grade C)", "95% (Grade A)", "+25 percentage points", "CIS 5.4.x Secrets checks", "Automated rotation tracking drives improvement"],
  ["Image Security Score", "60% (Grade D)", "92% (Grade A)", "+32 percentage points", "CIS 5.5.x Image checks", "Multi-scanner correlation improves accuracy"],
];

complianceMetrics.forEach((row, idx) => {
  row.forEach((val, ci) => {
    const cell = ws7.getCell(r, ci + 1);
    cell.value = val;
    if (ci === 0) {
      applyDataCell(cell, { bold: true, fill: C.bgLight });
    } else if (ci === 1) {
      applyDataCell(cell, { align: "center", fill: C.lightRed, fontColor: C.secRed, bold: true });
    } else if (ci === 2) {
      applyDataCell(cell, { align: "center", fill: C.lightGreen, fontColor: C.darkGreen, bold: true });
    } else if (ci === 3) {
      applyDataCell(cell, { align: "center", fill: C.lightBlue, fontColor: C.tcsBlue, bold: true });
    } else {
      applyDataCell(cell, { fill: idx % 2 === 0 ? C.white : C.bgLight });
    }
  });
  ws7.getRow(r).height = 34;
  r++;
});

r++;
applySectionRow(ws7, r, 6, "VULNERABILITY DETECTION & RESPONSE", C.navy);
r++;
metricHeaders.forEach((h, i) => { ws7.getCell(r, i + 1).value = h; });
applyHeaderRow(ws7, r, 6, C.tcsBlue);
r++;

const vulnMetrics = [
  ["Vulnerability Detection Rate", "68%", "97%", "+29 percentage points", "Known CVEs detected / total known CVEs in cluster", "Multi-scanner correlation dramatically improves detection"],
  ["False Positive Rate", "35-45%", "< 5%", "Reduced by 85%+", "False findings / total findings reported", "AI reachability analysis filters non-exploitable CVEs"],
  ["Mean Time to Detect (MTTD)", "5-14 days", "< 15 minutes", "99%+ reduction", "Time from CVE publication to detection in environment", "Continuous scanning vs periodic scan cycles"],
  ["Mean Time to Remediate (MTTR)", "21-45 days", "< 4 hours", "95%+ reduction", "Time from detection to verified remediation", "AI-generated patches with automated verification"],
  ["Critical CVE Response Time", "3-7 days", "< 30 minutes", "99%+ reduction", "Time from critical CVE alert to mitigation in place", "AI generates mitigation within minutes of CVE publication"],
  ["Scan Coverage", "60-70% of images", "100% of images", "30-40% increase", "Images scanned / total images running in cluster", "Automated discovery ensures no image is missed"],
];

vulnMetrics.forEach((row, idx) => {
  row.forEach((val, ci) => {
    const cell = ws7.getCell(r, ci + 1);
    cell.value = val;
    if (ci === 0) {
      applyDataCell(cell, { bold: true, fill: C.bgLight });
    } else if (ci === 1) {
      applyDataCell(cell, { align: "center", fill: C.lightRed, fontColor: C.secRed, bold: true });
    } else if (ci === 2) {
      applyDataCell(cell, { align: "center", fill: C.lightGreen, fontColor: C.darkGreen, bold: true });
    } else if (ci === 3) {
      applyDataCell(cell, { align: "center", fill: C.lightBlue, fontColor: C.tcsBlue, bold: true });
    } else {
      applyDataCell(cell, { fill: idx % 2 === 0 ? C.white : C.bgLight });
    }
  });
  ws7.getRow(r).height = 34;
  r++;
});

r++;
applySectionRow(ws7, r, 6, "OPERATIONAL EFFICIENCY", C.navy);
r++;
metricHeaders.forEach((h, i) => { ws7.getCell(r, i + 1).value = h; });
applyHeaderRow(ws7, r, 6, C.tcsBlue);
r++;

const opMetrics = [
  ["Audit Coverage (clusters)", "5-10 clusters/quarter", "All clusters continuously", "10x+ coverage increase", "Clusters audited / total clusters managed", "AI scales to hundreds of clusters with no additional effort"],
  ["Compliance Report Generation", "2-5 business days", "Real-time / on-demand", "Instant availability", "Time from report request to delivery", "Always-current dashboards replace manual report compilation"],
  ["Policy Violation Resolution Rate", "45-60%", "92%+", "+32-47 percentage points", "Violations resolved within SLA / total violations", "AI remediation proposals accelerate resolution"],
  ["Security Audit Preparation Time", "3-5 days per audit", "< 1 hour", "95%+ reduction", "Time to prepare evidence and reports for auditors", "Automated evidence collection and report generation"],
  ["RBAC Review Cycle", "Quarterly (often skipped)", "Continuous with weekly reports", "From quarterly to continuous", "Frequency of comprehensive RBAC analysis", "Automated analysis eliminates the excuse to skip reviews"],
  ["Policy Drift Detection", "Discovered at next audit", "Real-time detection", "From months to seconds", "Time from drift occurrence to detection", "Continuous monitoring catches drift immediately"],
];

opMetrics.forEach((row, idx) => {
  row.forEach((val, ci) => {
    const cell = ws7.getCell(r, ci + 1);
    cell.value = val;
    if (ci === 0) {
      applyDataCell(cell, { bold: true, fill: C.bgLight });
    } else if (ci === 1) {
      applyDataCell(cell, { align: "center", fill: C.lightRed, fontColor: C.secRed, bold: true });
    } else if (ci === 2) {
      applyDataCell(cell, { align: "center", fill: C.lightGreen, fontColor: C.darkGreen, bold: true });
    } else if (ci === 3) {
      applyDataCell(cell, { align: "center", fill: C.lightBlue, fontColor: C.tcsBlue, bold: true });
    } else {
      applyDataCell(cell, { fill: idx % 2 === 0 ? C.white : C.bgLight });
    }
  });
  ws7.getRow(r).height = 34;
  r++;
});

r++;
applySectionRow(ws7, r, 6, "RISK REDUCTION SUMMARY", C.navy);
r++;
const riskHeaders = ["Risk Category", "Before", "After", "Reduction", "Confidence Level", "Evidence Source"];
riskHeaders.forEach((h, i) => { ws7.getCell(r, i + 1).value = h; });
applyHeaderRow(ws7, r, 6, C.tcsBlue);
r++;

const riskMetrics = [
  ["Undetected Critical Vulnerabilities", "12-18 per cluster", "0-1 per cluster", "95%+ reduction", "High", "Multi-scanner cross-validation with AI verification"],
  ["Privilege Escalation Paths", "8-15 per cluster", "0-2 per cluster", "85%+ reduction", "High", "Graph-based RBAC analysis with path enumeration"],
  ["Non-Compliant Workloads", "35-50% of workloads", "< 5% of workloads", "90%+ reduction", "High", "Continuous CIS benchmark scanning"],
  ["Stale RBAC Permissions", "40-60% of bindings", "< 10% of bindings", "80%+ reduction", "Medium", "Audit log correlation with binding analysis"],
  ["Unmonitored Network Paths", "50-70% of namespaces", "< 5% of namespaces", "90%+ reduction", "High", "Network topology analysis with policy coverage mapping"],
  ["Secret Rotation Violations", "60-80% non-compliant", "< 10% non-compliant", "85%+ reduction", "High", "Automated rotation tracking and enforcement"],
];

riskMetrics.forEach((row, idx) => {
  row.forEach((val, ci) => {
    const cell = ws7.getCell(r, ci + 1);
    cell.value = val;
    if (ci === 0) {
      applyDataCell(cell, { bold: true, fill: C.bgLight });
    } else if (ci === 1) {
      applyDataCell(cell, { align: "center", fill: C.lightRed, fontColor: C.secRed, bold: true });
    } else if (ci === 2) {
      applyDataCell(cell, { align: "center", fill: C.lightGreen, fontColor: C.darkGreen, bold: true });
    } else if (ci === 3) {
      applyDataCell(cell, { align: "center", fill: C.lightBlue, fontColor: C.tcsBlue, bold: true });
    } else {
      applyDataCell(cell, { align: "center", fill: idx % 2 === 0 ? C.white : C.bgLight });
    }
  });
  ws7.getRow(r).height = 34;
  r++;
});

// ── Write file ──
wb.xlsx.writeFile(OUT).then(() => {
  console.log("Generated: " + OUT);
  console.log("Sheets:");
  wb.worksheets.forEach((ws) => console.log("  - " + ws.name));
}).catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
