/**
 * TCS Agentic AI — UC-07: Document-Driven Application Deployment
 * Generates: TCS-Agentic-AI-UC07-Doc-Driven-Deployment.xlsx (beside this script)
 *
 * Run: node usecases/uc-07-doc-driven-deployment/generate-excel.cjs
 */
const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");

const OUT = path.join(__dirname, "TCS-Agentic-AI-UC07-Doc-Driven-Deployment.xlsx");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const wb = new ExcelJS.Workbook();
wb.creator = "TCS Agentic AI Platform";
wb.created = new Date();
wb.title = "TCS Agentic AI — Document-Driven Application Deployment · UC-07";
wb.company = "Tata Consultancy Services";
wb.subject = "UC-07 — a versioned requirement document becomes a verified, governed application on OpenShift";

const C = {
  darkNavy: "0F172A", navy: "1E293B", tcsBlue: "2563EB", lightBlue: "DBEAFE", paleBlue: "EFF6FF",
  aiPurple: "7C3AED", lightPurple: "EDE9FE",
  autoGreen: "059669", lightGreen: "D1FAE5", darkGreen: "065F46",
  userAmber: "D97706", lightAmber: "FEF3C7", darkAmber: "92400E",
  valCyan: "0891B2", lightCyan: "CFFAFE",
  secRed: "DC2626", lightRed: "FEE2E2", darkRed: "991B1B",
  orange: "EA580C", lightOrange: "FFEDD5",
  white: "FFFFFF", bgLight: "F8FAFC", border: "CBD5E1",
  textDark: "1E293B", textMed: "475569", slate: "64748B", lightSlate: "F1F5F9",
};

const thin = { style: "thin", color: { argb: "FF" + C.border } };
const bd = { top: thin, bottom: thin, left: thin, right: thin };
const F = "Calibri";
const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb: "FF" + argb } });

function banner(ws, title, subtitle, span) {
  ws.mergeCells(1, 1, 1, span);
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { name: F, size: 16, bold: true, color: { argb: "FF" + C.white } };
  t.fill = fill(C.darkNavy);
  t.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  ws.getRow(1).height = 32;
  if (subtitle) {
    ws.mergeCells(2, 1, 2, span);
    const s = ws.getCell(2, 1);
    s.value = subtitle;
    s.font = { name: F, size: 10.5, italic: true, color: { argb: "FF" + C.textMed } };
    s.fill = fill(C.paleBlue);
    s.alignment = { vertical: "middle", horizontal: "left", indent: 1, wrapText: true };
    ws.getRow(2).height = 26;
    return 4;
  }
  return 3;
}
function headerRow(ws, rowIdx, cells) {
  const r = ws.getRow(rowIdx);
  cells.forEach((c, i) => {
    const cell = r.getCell(i + 1);
    cell.value = c;
    cell.font = { name: F, size: 10.5, bold: true, color: { argb: "FF" + C.white } };
    cell.fill = fill(C.navy);
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true, indent: 1 };
    cell.border = bd;
  });
  r.height = 26;
  return rowIdx + 1;
}
function dataRows(ws, startRow, rows, opts = {}) {
  let r = startRow;
  rows.forEach((row, ri) => {
    const xr = ws.getRow(r);
    row.forEach((v, i) => {
      const cell = xr.getCell(i + 1);
      const isObj = v && typeof v === "object" && !Array.isArray(v);
      cell.value = isObj ? v.t : v;
      cell.font = { name: F, size: 10, bold: isObj ? !!v.b : (i === 0 && opts.boldFirst !== false),
        color: { argb: "FF" + (isObj && v.c ? v.c : C.textDark) } };
      cell.fill = fill(isObj && v.bg ? v.bg : (ri % 2 === 0 ? C.white : C.bgLight));
      cell.alignment = { vertical: "top", horizontal: "left", wrapText: true, indent: 1 };
      cell.border = bd;
    });
    xr.height = opts.height || 30;
    r++;
  });
  return r;
}
function note(ws, rowIdx, span, text, bg, fg) {
  ws.mergeCells(rowIdx, 1, rowIdx, span);
  const c = ws.getCell(rowIdx, 1);
  c.value = text;
  c.font = { name: F, size: 10.5, bold: true, color: { argb: "FF" + fg } };
  c.fill = fill(bg);
  c.alignment = { vertical: "middle", horizontal: "left", wrapText: true, indent: 1 };
  c.border = bd;
  ws.getRow(rowIdx).height = 34;
  return rowIdx + 2;
}
const AI = { t: "🤖 AI", b: true, c: "5B21B6", bg: C.lightPurple };
const AU = { t: "⚙️ AUTOMATIC", b: true, c: "1E40AF", bg: C.lightBlue };
const MA = { t: "👤 MANUAL", b: true, c: C.darkAmber, bg: C.lightAmber };
const OK = { t: "✅ VERIFIED", b: true, c: C.darkGreen, bg: C.lightGreen };
const RM = { t: "🔶 ROADMAP", b: true, c: C.darkAmber, bg: C.lightAmber };

// ═══ 1. OVERVIEW ════════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("1. Overview", { properties: { tabColor: { argb: "FF" + C.tcsBlue } } });
  ws.columns = [{ width: 30 }, { width: 95 }];
  let r = banner(ws, "TCS Agentic AI — Document-Driven Application Deployment  ·  UC-07",
    "The requirement document IS the deployment: versioned in Git, deterministic on the wire, verified until a human can click the URL.", 2);
  r = headerRow(ws, r, ["Attribute", "Detail"]);
  r = dataRows(ws, r, [
    ["Use case ID", "UC-07"],
    ["Full name", "TCS Agentic AI — Document-Driven Application Deployment (App Deployment Agent)"],
    ["Product family", "TCS Agentic AI for Hybrid Infrastructure · Container & Kubernetes Operations"],
    ["Platform", "OpenShift / Kubernetes (hub + spoke clusters)"],
    ["Tagline", "Upload a document. Open a working application."],
    ["Description", "A requirement document — Markdown or Word, uploaded, pasted, or pulled straight from GitHub — becomes a complete, security-hardened, zero-trust application: generated, dry-run, deployed by server-side apply, and verified level by level until the proof is a live URL. Every deploy leaves a durable record, a ServiceNow change, and a citation of the exact versioned document that produced it."],
    ["Trigger", "HUMAN-INITIATED: upload / paste / Git URL. Roadmap: webhook on a merged doc change."],
    ["Reference application", "Online Boutique — 11 gRPC microservices + Redis + synthetic shoppers → 64 manifests from one document"],
    ["Human touchpoints", "Two: review the generated YAML and click Deploy; approve a proposed fix if verification goes red."],
    ["Sample inputs", "docs/sample-requirements/ 01-hello-web · 02-three-tier-orders · 03-negative (fails on purpose) · 04-ecommerce-online-boutique — each in .md and .docx"],
    ["Demo time", "5–7 min boutique (first image pulls) · ~90 s hello-web"],
  ], { height: 32 });
  note(ws, r, 2, "The differentiator: generation may be creative — verification never is. The AI architects and investigates; every claim about the cluster is measured, not generated.", C.lightBlue, "1E40AF");
}

// ═══ 2. ACTOR MODEL ═════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("2. Actor Model", { properties: { tabColor: { argb: "FF" + C.aiPurple } } });
  ws.columns = [{ width: 22 }, { width: 30 }, { width: 72 }];
  let r = banner(ws, "Who does what", "Purple reasons · blue repeats exactly · amber decides · green is proven", 3);
  r = headerRow(ws, r, ["Actor", "Colour code", "Role in UC-07"]);
  r = dataRows(ws, r, [
    [AI, "Purple", "Architects manifests from free prose; drives conversational ops via 15 MCP agents (177 tools); investigates red verification levels with the UC-05 RCA machinery"],
    [AU, "Blue", "Deterministic extraction of structured documents, manifest generation, server-side apply, governance records, and the entire verification pyramid"],
    [MA, "Amber", "Reviews the generated YAML, clicks Deploy, approves proposed fixes — the only irreversible decisions"],
    [OK, "Green", "An outcome proven against the live cluster: a rollout completed, a Service wired, a URL answering"],
  ], { height: 34 });
  note(ws, r, 3, "The deliberate design: structured documents get NO model in the loop — an audit-grade input must produce byte-identical output. The AI's contribution there was designing the grammar, not executing it.", C.lightPurple, "5B21B6");
}

// ═══ 3. WORKFLOW ════════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("3. Workflow", { properties: { tabColor: { argb: "FF" + C.tcsBlue } } });
  ws.columns = [{ width: 6 }, { width: 44 }, { width: 18 }, { width: 62 }];
  let r = banner(ws, "End-to-end workflow — every step, with its actor",
    "14 automatic · 2 AI · 3 human · ends at a URL a person can click", 4);
  r = headerRow(ws, r, ["#", "Step", "Actor", "Notes"]);
  r = dataRows(ws, r, [
    [1, "Requirement document authored and PR-reviewed in Git", MA, "Markdown or Word; the tables are the contract, the prose is documentation"],
    [2, "Document loaded — upload, paste, or 'Load from Git'", MA, "GitHub blob links rewritten to raw automatically; .docx converted with tables preserved; private repos via one-shot token"],
    [3, "Structured or prose? The pipeline forks", AU, "Structured tables → deterministic lane. Free prose / PDF → AI lane"],
    [4, "Deterministic extraction (structured lane)", AU, "Headings + tables → typed intent: tiers, images, ports, env, probes, storage, connectivity matrix. Same commit → same result, every time"],
    [5, "LLM architects the manifests (prose lane)", AI, "Under a prompt contract: CIS + Pod Security 'restricted', non-root images, least privilege — for requirements with no tables to parse"],
    [6, "Manifests generated — 64 for the boutique", AU, "Zero-trust matrix enforced BOTH directions, DNS egress granted, Secrets generated with random credentials, native gRPC probes, HPA, edge-TLS Route"],
    [7, "Human reviews the editable YAML", MA, "Edits are what gets dry-run and deployed; 'Reset to generated' restores"],
    [8, "Shift-left checks on the generated code", AU, "CIS benchmark + image CVE scan, before anything touches a cluster"],
    [9, "Server-side dry-run", AU, "Target namespace prepared, then full admission validation of every object — nothing else created"],
    [10, "DEPLOY — the gate", MA, "The one irreversible click. Cluster chosen from the connected fleet"],
    [11, "Server-side apply, dependency-ordered", AU, "Each object reported created / configured / unchanged, kubectl-apply style; re-deploys update in place"],
    [12, "Durable record + change governance", AU, "doc_deployments row (survives restarts) + change-timeline event + ServiceNow CR with implementation, backout and test plans — citing the Git source URL"],
    [13, "Live pod watch", AU, "kubectl-style table streaming until everything is Ready"],
    [14, "Verification L1 — rollout complete", AU, "kubectl rollout status semantics per workload: THIS generation, not old-pods-still-Ready"],
    [15, "Verification L2 — workloads stable", AU, "No crash loops, no accumulating restarts"],
    [16, "Verification L3 — services wired", AU, "Every selector-bearing Service has ready endpoints — catches the label mismatch behind 'Route says 503'"],
    [17, "Verification L4 — user can access", AU, "The platform itself HTTP-probes every Route from outside the pods"],
    [18, "'Open application' — the acceptance test", MA, "A human clicks a live URL with a green status dot. For the boutique: place an order across 9 services and Redis"],
    [19, "If any level is red → RCA investigation", AI, "UC-05 machinery reasons over logs, events and probes; proposes a fix a human approves (auto-wiring is roadmap)"],
  ], { height: 30, boldFirst: false });
  note(ws, r, 4, "Steps 7, 10 and 18 are the only places a person is required — review, deploy, and the final click that proves it works.", C.lightAmber, C.darkAmber);
}

// ═══ 4. AGENTIC AI MAP ══════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("4. Agentic AI Map", { properties: { tabColor: { argb: "FF" + C.aiPurple } } });
  ws.columns = [{ width: 40 }, { width: 18 }, { width: 72 }];
  let r = banner(ws, "Where the agentic AI actually is — an honest map",
    "The AI is the operator; determinism is the contract", 3);
  r = headerRow(ws, r, ["Stage", "Actor", "Why this actor"]);
  r = dataRows(ws, r, [
    ["Free-prose requirement → manifests", AI, "'Deploy a web app with Postgres and monitoring' has no tables. The LLM acts as platform architect under a hardening prompt contract"],
    ["Structured document → manifests", AU, "The tables ARE a contract; a model would paraphrase. Byte-identical YAML per commit is the audit requirement"],
    ["Conversational operations (AI Chat)", AI, "The same pipeline is drivable in natural language through the platform's MCP agents — and by ANY external framework via /mcp/<agent>/sse"],
    ["Shift-left security verdicts", AU, "CIS and CVE scanning are deterministic; the AI explains findings and proposes remediations on request"],
    ["Change governance (ServiceNow CR)", AU, "Authored automatically from the deploy itself — implementation, backout, test plans"],
    ["Verification pyramid", AU, "Truth about the cluster must not be generated. Rollout, stability, wiring, URL — measured, never inferred"],
    ["Failure investigation", AI, "A red level hands evidence to the RCA agent (UC-05): reason over logs/events/probes, propose the fix"],
    ["The irreversible clicks", MA, "Deploy and fix-approval stay human. The AI narrows the decision; it does not take it"],
  ], { height: 34 });
  note(ws, r, 3, "Say this line in the demo: generation may be creative — verification never is. 93 unit tests pin the deterministic lanes.", C.lightPurple, "5B21B6");
}

// ═══ 5. ARCHITECTURE ════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("5. Architecture", { properties: { tabColor: { argb: "FF" + C.navy } } });
  ws.columns = [{ width: 30 }, { width: 34 }, { width: 66 }];
  let r = banner(ws, "Components — sources of truth → hub → systems of record",
    "The interactive diagram lives in use-case.md; this is the same architecture as a component matrix", 3);
  r = headerRow(ws, r, ["Component", "Implementation", "Responsibility"]);
  r = dataRows(ws, r, [
    ["Document ingestion", "extract-doc · fetch-doc APIs", ".md / .docx / .pdf / text; docx tables preserved; GitHub blob→raw rewrite; one-shot tokens for private repos; 60k char budget"],
    ["Deterministic extractor", "ais-extractor.js", "Headings + key/value tables → Application Intent Schema; exact-match column resolution"],
    ["LLM architect (prose lane)", "chat-api.js generate-manifest", "Engaged ONLY when no structured tables are found; CIS/PSS-restricted prompt contract"],
    ["Manifest generator", "manifest-generator.js", "Zero-trust matrix both directions, DNS egress, generated Secrets, native gRPC probes, HPA, Routes, init-SQL Jobs"],
    ["Apply engine", "deploy-verifier.js applyResource", "Server-side apply; created / configured / unchanged; dry-run with namespace preparation"],
    ["Verification pyramid", "deploy-verifier.js verifyNamespace", "Rollout → stability → Service/endpoint wiring → HTTP probe of every Route"],
    ["Durable records", "doc-deploy-store.js (PostgreSQL)", "Deploy history that survives pod restarts; rollback ledger scoped to what the deploy CREATED"],
    ["Governance", "servicenow-client.js", "Change request per deploy — implementation / backout / test plans — 6-second budget, never blocks"],
    ["Agent surface", "15 MCP agents · 177 tools", "The same capabilities drivable by chat or by any external framework over /mcp/<agent-id>/sse"],
    ["Target estate", "Hub + spoke OpenShift clusters", "Deploy-to-cluster selector; per-cluster context on every API call"],
  ], { height: 32 });
}

// ═══ 6. VERIFICATION PYRAMID ════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("6. Verification Pyramid", { properties: { tabColor: { argb: "FF" + C.autoGreen } } });
  ws.columns = [{ width: 26 }, { width: 52 }, { width: 52 }];
  let r = banner(ws, "'Done' means a human can use it — four levels, each stronger than the last",
    "Pods-are-Ready is a claim about containers. These are claims about the application.", 3);
  r = headerRow(ws, r, ["Level", "Question it answers", "Failure it catches"]);
  r = dataRows(ws, r, [
    ["1 · Rollout complete", "Is THIS generation fully rolled out? (kubectl rollout status semantics)", "Old pods still Ready passing a naive readiness check — the exact trap fixed in UC-05"],
    ["2 · Workloads stable", "Anything crash-looping or accumulating restarts?", "Probe misconfiguration, OOM, bad env — including the distroless-image probe class"],
    ["3 · Services wired", "Does every selector-bearing Service have ready endpoints?", "The label/selector mismatch behind most 'Route says 503' incidents"],
    ["4 · User can access", "Does every Route answer over HTTP from outside the pods?", "Everything else between the user and the app — including the router's own 503"],
  ], { height: 36 });
  r = note(ws, r, 3, "The flow ends at an 'Open application' button with a live status dot — the user's acceptance test, executed by the platform.", C.lightGreen, C.darkGreen);
  note(ws, r, 3, "Sample doc 03 fails ON PURPOSE (broken image tag) so audiences watch the pyramid go red honestly. A green result means something because red is possible.", C.lightRed, C.darkRed);
}

// ═══ 7. SECURITY MODEL ══════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("7. Security Model", { properties: { tabColor: { argb: "FF" + C.secRed } } });
  ws.columns = [{ width: 30 }, { width: 100 }];
  let r = banner(ws, "Security controls — generated, not hand-assembled", null, 2);
  r = headerRow(ws, r, ["Control", "Detail"]);
  r = dataRows(ws, r, [
    ["Zero-trust networking", "default-deny BOTH directions; every allowed path in the document's connectivity matrix generates ingress on the target AND egress on the caller; DNS egress scoped to openshift-dns; the denied paths are listed in the document for auditability"],
    ["Secrets", "Generated with random credentials at manifest time — never present in the document, the chat, or Git"],
    ["Images", "Restricted-SCC compatible (arbitrary UID, non-root); shift-left CIS + image CVE scan before deploy"],
    ["Blast radius", "Rollback deletes ONLY what the deployment created; updated resources and pre-existing namespaces are never touched"],
    ["Change trail", "Durable record + change-timeline event + ServiceNow CR with backout plan, citing the versioned source document"],
    ["Negative control", "The three-tier sample includes a validation step proving the web tier CANNOT reach the database directly — deny is demonstrated, not assumed"],
  ], { height: 40 });
}

// ═══ 8. DOCS-AS-CODE ════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("8. Docs-as-Code", { properties: { tabColor: { argb: "FF" + C.valCyan } } });
  ws.columns = [{ width: 8 }, { width: 44 }, { width: 76 }];
  let r = banner(ws, "The Git story — version control is the front door",
    "The document is reviewed like code, versioned like code, and deployed from its commit", 3);
  r = headerRow(ws, r, ["#", "Step", "Detail"]);
  r = dataRows(ws, r, [
    [1, "Document lives in a Git repo", "PR-reviewed, versioned, diffable — .md or .docx"],
    [2, "'Load from Git' in the console", "Paste the normal GitHub link; blob URLs rewritten to raw automatically; .docx converted on the fly"],
    [3, "Deterministic generate", "Same commit → same 64 manifests, byte for byte — no model in the loop"],
    [4, "Provenance travels with the deploy", "The deploy record AND the ServiceNow CR cite the source URL: audit walks from a running pod back to the document version that created it"],
    [5, "Re-deploy after a doc change", "Fetch → generate → deploy; server-side apply updates only what changed and says so (created / configured / unchanged)"],
  ], { height: 32, boldFirst: false });
  note(ws, r, 3, "Roadmap, in order of value: webhook auto-deploy to dev on a merged PR → environment promotion (same document, dev → staging → prod) → GitOps hand-off (commit generated YAML for Argo CD to sync).", C.lightCyan, "155E75");
}

// ═══ 9. SAMPLE DOCUMENTS ════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("9. Sample Documents", { properties: { tabColor: { argb: "FF" + C.orange } } });
  ws.columns = [{ width: 34 }, { width: 56 }, { width: 40 }];
  let r = banner(ws, "Known-good inputs — each in .md and .docx",
    "docs/sample-requirements/ · pinned by round-trip unit tests so they cannot silently break", 3);
  r = headerRow(ws, r, ["Document", "What it proves", "Expected result"]);
  r = dataRows(ws, r, [
    ["01-hello-web", "The pipeline end to end: one nginx tier, TLS route, probes", { t: "Green pyramid + working URL in ~90 seconds", c: C.darkGreen, bg: C.lightGreen }],
    ["02-three-tier-orders", "Web + API + PostgreSQL 15: generated Secret, ConfigMap, PVC, init-SQL Job as the functional DB proof, zero-trust matrix with a negative control, HPA", { t: "Green in 2–4 minutes", c: C.darkGreen, bg: C.lightGreen }],
    ["03-negative-broken-image", "The pyramid fails honestly — bad image tag, rollout can never complete", { t: "RED at level 1, by design", c: C.darkRed, bg: C.lightRed }],
    ["04-ecommerce-online-boutique", "A real e-commerce shop: 11 gRPC microservices + Redis + synthetic shoppers → 64 manifests, 19-row matrix, native gRPC probes", { t: "Green in 3–6 minutes (12 image pulls)", c: C.darkGreen, bg: C.lightGreen }],
  ], { height: 40 });
  note(ws, r, 3, "Boutique images pull from Google's public registry (us-central1-docker.pkg.dev). If the cluster cannot reach it, mirror the 12 images internally and edit only the image rows.", C.lightOrange, "9A3412");
}

// ═══ 10. BUSINESS VALUE ═════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("10. Business Value", { properties: { tabColor: { argb: "FF" + C.autoGreen } } });
  ws.columns = [{ width: 38 }, { width: 45 }, { width: 45 }];
  let r = banner(ws, "Manual baseline vs UC-07", null, 3);
  r = headerRow(ws, r, ["Metric", "Manual baseline", "UC-07"]);
  r = dataRows(ws, r, [
    ["Requirement → running application", { t: "Days: ticket, YAML authoring, review cycles", c: C.darkRed, bg: C.lightRed }, { t: "Minutes, from a reviewed document", c: C.darkGreen, bg: C.lightGreen }],
    ["YAML authored by hand", { t: "~2,000 lines for the boutique", c: C.darkRed, bg: C.lightRed }, { t: "0 — 64 manifests generated", c: C.darkGreen, bg: C.lightGreen }],
    ["Security posture per namespace", { t: "Varies by engineer and deadline", c: C.darkRed, bg: C.lightRed }, { t: "Identical, generated, unit-tested", c: C.darkGreen, bg: C.lightGreen }],
    ["'Who deployed what, from what?'", { t: "Archaeology across tickets and terminals", c: C.darkRed, bg: C.lightRed }, { t: "Record cites the Git URL, CR number, verification result", c: C.darkGreen, bg: C.lightGreen }],
    ["Definition of done", { t: "'Pods are green'", c: C.darkRed, bg: C.lightRed }, { t: "A probed URL and a four-level proof", c: C.darkGreen, bg: C.lightGreen }],
    ["Re-deploy after a change", { t: "Re-apply and hope; drift accumulates", c: C.darkRed, bg: C.lightRed }, { t: "SSA reports created / configured / unchanged per object", c: C.darkGreen, bg: C.lightGreen }],
  ], { height: 34 });
}

// ═══ 11. DEMO SCRIPT ════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("11. Demo Script", { properties: { tabColor: { argb: "FF" + C.tcsBlue } } });
  ws.columns = [{ width: 10 }, { width: 34 }, { width: 84 }];
  let r = banner(ws, "Six minutes, ending in a purchase", null, 3);
  r = headerRow(ws, r, ["Minute", "Beat", "Say"]);
  r = dataRows(ws, r, [
    ["0–1", "The document in GitHub (or Word)", "\"This is the deployment. Not YAML — a reviewed, versioned requirement document.\""],
    ["1–2", "Load from Git → Generate", "\"Deterministic: 12 tiers, 64 manifests, no AI paraphrase — same commit, same YAML. And the AI lane: paste plain prose instead, and the LLM architects it under the same hardening contract.\""],
    ["2–3", "CIS + image scan → Dry-run", "\"Shift-left: the API server validated all 64 objects before anything ran.\""],
    ["3–5", "Deploy → pod watch → pyramid", "\"Server-side apply, a change record in ServiceNow citing the document — and now the platform proves it: rollout, stability, wiring, and it browses to the shop itself.\""],
    ["5–6", "Open application → place an order", "\"One click crosses nine services and Redis, every hop through a network policy this document declared. Had any level gone red, the RCA agent takes it from there.\""],
  ], { height: 40, boldFirst: false });
  note(ws, r, 3, "Optional 60-second encore: deploy 03-negative-broken-image and watch the pyramid fail honestly — green means something because red is possible.", C.lightAmber, C.darkAmber);
}

// ═══ 12. VERIFICATION STATUS ════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("12. Verification Status", { properties: { tabColor: { argb: "FF" + C.userAmber } } });
  ws.columns = [{ width: 60 }, { width: 24 }, { width: 46 }];
  let r = banner(ws, "What is live vs what is roadmap — stated plainly", null, 3);
  r = headerRow(ws, r, ["Claim", "Status", "Evidence"]);
  r = dataRows(ws, r, [
    ["Deterministic extraction — .md and .docx extract identically", OK, "Round-trip unit tests (93 passing overall)"],
    ["64-manifest generation, zero-trust matrix both directions", OK, "Unit-tested; deployed live on the caaslab cluster"],
    ["Server-side apply with created/configured/unchanged", OK, "Live; re-deploys update in place"],
    ["Dry-run with namespace preparation", OK, "Live — fixed after the first field run surfaced the 404 class"],
    ["Verification pyramid incl. URL probe", OK, "Live"],
    ["Git fetch (blob→raw) → deterministic generate", OK, "Verified against the GitHub branch: 13,830 chars → 64 manifests"],
    ["ServiceNow change record per deploy", OK, "CHG0030065 raised in the lab"],
    ["RCA-agent auto-investigation of a red level", RM, "UC-05 machinery exists; automatic hand-off is the next build"],
    ["Webhook auto-deploy · env promotion · Argo CD hand-off", RM, "Design settled (sheet 8), not yet built"],
  ], { height: 30 });
  note(ws, r, 3, "This sheet is deliberately honest. Claims marked VERIFIED ran against a live cluster or are pinned by the test suite; ROADMAP items are designs, not demos.", C.lightAmber, C.darkAmber);
}

wb.xlsx.writeFile(OUT).then(() => {
  console.log(`Wrote ${OUT}`);
  console.log(`  ${wb.worksheets.length} sheets`);
});
