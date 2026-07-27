/**
 * Incident RCA — professional HTML report.
 *
 * The plain-text RCA is what ServiceNow close notes need; this is what a human
 * (or an auditor) should see in a browser. Self-contained: no external CSS,
 * fonts or images, so it renders identically offline, when saved to a file, and
 * when printed to PDF.
 *
 * Structure follows the same ITIL 4 / Google SRE / NIST SP 800-61 section order
 * as the text document, so the two are directly comparable.
 */

import PDFDocument from "pdfkit";

const C = {
  navy: "#0f172a", slate900: "#1e293b", slate600: "#475569", slate400: "#94a3b8",
  slate200: "#e2e8f0", slate50: "#f8fafc",
  blue: "#2563eb", blueL: "#dbeafe",
  purple: "#7c3aed", purpleL: "#ede9fe",
  green: "#059669", greenL: "#d1fae5",
  amber: "#d97706", amberL: "#fef3c7",
  red: "#dc2626", redL: "#fee2e2",
  cyan: "#0891b2", cyanL: "#cffafe",
};

const SEV_TONE = {
  "SEV-1": { bg: C.redL, fg: "#991b1b", bar: C.red },
  "SEV-2": { bg: C.redL, fg: "#991b1b", bar: C.red },
  "SEV-3": { bg: C.amberL, fg: "#92400e", bar: C.amber },
  "SEV-4": { bg: C.blueL, fg: "#1e40af", bar: C.blue },
  "SEV-5": { bg: C.greenL, fg: "#065f46", bar: C.green },
};

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const mins = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)) : null);
const fmtTs = (t) => (t ? String(t).replace("T", " ").replace(/\.\d+Z?$/, "").replace("Z", "") + " UTC" : "—");

function section(num, title, body, opts = {}) {
  if (!body) return "";
  return `<section class="sec">
    <h2><span class="num">${esc(num)}</span>${esc(title)}${opts.badge || ""}</h2>
    <div class="sec-body">${body}</div>
  </section>`;
}

function kv(rows) {
  return `<table class="kv">${rows.filter(Boolean).map(([k, v]) =>
    `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join("")}</table>`;
}

function chips(items, tone = "blue") {
  if (!items?.length) return "";
  return `<div class="chips">${items.map((i) => `<span class="chip ${tone}">${esc(i)}</span>`).join("")}</div>`;
}

function bullets(items) {
  if (!items?.length) return "";
  return `<ul class="bul">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
}

function pre(lines, cls = "") {
  if (!lines?.length) return "";
  return `<pre class="term ${cls}">${lines.map((l) => esc(l)).join("\n")}</pre>`;
}

/**
 * Render the full RCA as a standalone HTML document.
 * @param {object} s incident session
 * @returns {string} complete HTML
 */
export function renderRCAHtml(s) {
  const r = s.rca || {};
  const tone = SEV_TONE[s.severity] || SEV_TONE["SEV-3"];
  const mttd = mins(s.firstSeen, s.detectedAt);
  const mtta = mins(s.detectedAt, s.approvedAt);
  const mttr = mins(s.detectedAt, s.resolvedAt);

  const stateLabel = {
    closed: s.selfHealed ? "Closed — self-healed" : s.ticketClosed ? "Closed — RCA attached" : "Closed",
    resolved: "Resolved", escalated: "Escalated — needs a human",
    awaiting_approval: "Awaiting approval", rolled_back: "Rolled back — not verified",
    failed: "Failed", rejected: "Rejected",
  }[s.state] || s.state;

  const metrics = [
    { label: "MTTD", value: mttd, hint: "detect" },
    { label: "MTTA", value: mtta, hint: "approve" },
    { label: "MTTR", value: mttr, hint: "resolve" },
  ].filter((m) => m.value != null);

  // ── Timeline ──
  const tl = [
    ["Condition began", s.firstSeen],
    ["Detected", s.detectedAt],
    ["Ticket raised", s.incidentRaisedAt],
    ["Fix dry-run", s.dryRunAt],
    ["Approved", s.approvedAt],
    ["Remediated", s.remediatedAt],
    ["Resolved", s.resolvedAt],
    ["Closed", s.closedAt],
  ].filter(([, v]) => v);
  const timelineHtml = `<ol class="tl">${tl.map(([k, v], i) => `
    <li class="${i === tl.length - 1 ? "last" : ""}">
      <span class="tl-dot"></span>
      <span class="tl-k">${esc(k)}</span>
      <span class="tl-v">${esc(fmtTs(v))}</span>
      ${k === "Approved" && s.approvedBy ? `<span class="tl-by">by ${esc(s.approvedBy)}</span>` : ""}
    </li>`).join("")}</ol>`;

  // ── 5-Whys ──
  const why = (r.whyChain?.length ? r.whyChain : (r.causalChain || []).map((c) => c.cause || c.evidence)).filter(Boolean);
  const whyHtml = why.length ? `<ol class="why">${why.map((w, i) => `
    <li><span class="why-tag">${i === 0 ? "Symptom" : i === why.length - 1 ? "Root cause" : `Why ${i}`}</span>
    <span>${esc(w)}</span></li>`).join("")}</ol>` : "";

  // ── Evidence ──
  const evParts = [];
  if (r.evidence?.length || r.restarts || r.exitCodes?.length) {
    const obs = [...(r.evidence || [])];
    if (r.restarts) obs.push(`Total container restarts: ${r.restarts}`);
    for (const x of r.exitCodes || []) {
      obs.push(`Container "${x.container}" terminated: ${x.reason || "?"} (exit ${x.code ?? "?"})`);
    }
    evParts.push(`<h3>5.1 Threshold observations</h3>${bullets(obs)}`);
  }
  if (r.limits?.length) {
    evParts.push(`<h3>5.2 Resource configuration</h3><table class="tbl">
      <thead><tr><th>Container</th><th>Limits</th><th>Requests</th></tr></thead>
      <tbody>${r.limits.map((l) => `<tr><td><code>${esc(l.container)}</code></td>
        <td><code>${esc(JSON.stringify(l.limits))}</code></td>
        <td><code>${esc(JSON.stringify(l.requests))}</code></td></tr>`).join("")}</tbody></table>`);
  }
  evParts.push(`<h3>5.3 Log evidence</h3>${
    r.logLines?.length
      ? pre(r.logLines.slice(0, 20))
      : `<p class="muted">No error output captured — the container may not have produced any before termination.</p>`}`);
  if (r.events?.length) {
    evParts.push(`<h3>5.4 Kubernetes warning events</h3><table class="tbl">
      <thead><tr><th>Reason</th><th>Message</th></tr></thead>
      <tbody>${r.events.map((e) => `<tr><td><code>${esc(e.reason)}</code></td><td>${esc(e.message)}</td></tr>`).join("")}</tbody></table>`);
  }
  if (r.kbMatches?.length) {
    evParts.push(`<h3>5.5 Known-error knowledge base matches</h3><table class="tbl">
      <thead><tr><th>Known error</th><th>Matched</th><th>Standard remediation</th></tr></thead>
      <tbody>${r.kbMatches.map((m) => `<tr><td>${esc(m.rootCause || "—")}</td>
        <td>${m.matched ? `<code>${esc(String(m.matched).slice(0, 60))}</code>` : "—"}</td>
        <td>${esc(m.remediation || "—")}</td></tr>`).join("")}</tbody></table>`);
  }

  // ── Resolution ──
  const resolutionHtml = s.remediation?.command ? `
    ${kv([
      ["Action", `<code>${esc(s.remediation.action)}</code>`],
      ["Risk", `<span class="chip ${s.remediation.risk === "low" ? "green" : "amber"}">${esc(s.remediation.risk)}</span>
                <span class="chip ${s.remediation.reversible ? "green" : "red"}">${s.remediation.reversible ? "reversible" : "NOT reversible"}</span>`],
      ["Approved by", esc(s.approvedBy || "—")],
      s.remediation.rationale && ["Rationale", esc(s.remediation.rationale)],
    ])}
    <h3>Command executed</h3>
    ${pre([`$ ${s.remediation.command}`], "cmd")}
    ${s.dryRunOutput ? `<h3>Dry-run output</h3>${pre([String(s.dryRunOutput)])}` : ""}
    ${s.applyOutput ? `<h3>Apply output</h3>${pre([String(s.applyOutput)])}` : ""}
  ` : `<p class="muted">No safe automated remediation was available; the incident was escalated for human action.${
      s.escalationReason ? ` <strong>${esc(s.escalationReason)}</strong>` : ""}</p>`;

  // ── Verification ──
  const verHtml = s.verification
    ? `<div class="callout ${s.verification.ok ? "ok" : "warn"}">
         <strong>${s.verification.ok ? "Verified" : "Not verified"}</strong>
         <span>${esc(s.verification.summary)}</span>
         ${s.verification.attempts ? `<span class="muted">(${s.verification.attempts} check${s.verification.attempts === 1 ? "" : "s"})</span>` : ""}
       </div>`
    : `<p class="muted">Not verified.</p>`;

  // ── CAPA ──
  const capa = [
    ...(r.preventiveActions || []),
    ...(s.occurrences > 1 ? [`Recurring ${s.occurrences}× — raise a Problem record for a permanent fix.`] : []),
  ];

  const aiBadge = r.aiAnalysed
    ? `<span class="badge purple">AI analysed${r.confidence ? ` · ${esc(r.confidence)} confidence` : ""}</span>`
    : `<span class="badge grey">Deterministic</span>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RCA ${esc(s.incidentNumber || s.id)} — ${esc(s.title)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:${C.slate50};color:${C.slate900};
    font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Arial,sans-serif;
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:1000px;margin:0 auto;padding:0 0 60px}
  header{background:${C.navy};color:#fff;padding:26px 34px 22px;border-bottom:4px solid ${tone.bar}}
  .eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${C.cyan};font-weight:700}
  h1{margin:8px 0 4px;font-size:23px;font-weight:700;line-height:1.3}
  .sub{color:${C.slate400};font-size:13px}
  .hdr-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;align-items:center}
  .badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11.5px;font-weight:700}
  .badge.sev{background:${tone.bg};color:${tone.fg}}
  .badge.purple{background:${C.purpleL};color:#5b21b6}
  .badge.grey{background:#334155;color:${C.slate200}}
  .badge.state{background:rgba(255,255,255,.14);color:#fff}

  .metrics{display:flex;flex-wrap:wrap;gap:10px;padding:18px 34px 0}
  .metric{flex:1;min-width:140px;background:#fff;border:1px solid ${C.slate200};border-radius:10px;padding:12px 14px}
  .metric b{display:block;font-size:24px;font-weight:800;color:${C.blue};line-height:1.1}
  .metric span{font-size:11px;color:${C.slate600};text-transform:uppercase;letter-spacing:.05em;font-weight:600}
  .metric i{display:block;font-size:11px;color:${C.slate400};font-style:normal}

  .sec{background:#fff;margin:16px 34px 0;border:1px solid ${C.slate200};border-radius:12px;overflow:hidden}
  .sec h2{margin:0;padding:13px 18px;background:${C.slate50};border-bottom:1px solid ${C.slate200};
    font-size:14px;font-weight:700;display:flex;align-items:center;gap:10px}
  .sec h2 .num{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:6px;
    background:${C.navy};color:#fff;font-size:11.5px;font-weight:700;flex:none}
  .sec-body{padding:16px 18px}
  .sec h3{margin:18px 0 7px;font-size:12.5px;font-weight:700;color:${C.slate600};
    text-transform:uppercase;letter-spacing:.05em}
  .sec h3:first-child{margin-top:0}
  p{margin:0 0 10px}
  .lead{font-size:15px;line-height:1.65}
  .muted{color:${C.slate600};font-size:13px}

  table.kv{width:100%;border-collapse:collapse}
  table.kv th{text-align:left;width:170px;padding:6px 10px 6px 0;color:${C.slate600};
    font-weight:600;font-size:12.5px;vertical-align:top;white-space:nowrap}
  table.kv td{padding:6px 0;vertical-align:top}
  table.tbl{width:100%;border-collapse:collapse;font-size:13px;margin:4px 0 2px}
  table.tbl th{text-align:left;background:${C.slate50};padding:8px 10px;border:1px solid ${C.slate200};
    font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:${C.slate600}}
  table.tbl td{padding:8px 10px;border:1px solid ${C.slate200};vertical-align:top}
  code{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    background:${C.slate50};border:1px solid ${C.slate200};border-radius:4px;padding:1px 5px}

  pre.term{background:${C.navy};color:#e2e8f0;padding:13px 15px;border-radius:9px;overflow-x:auto;
    font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin:4px 0 2px;
    white-space:pre-wrap;word-break:break-word}
  pre.term.cmd{background:#111827;color:#86efac;border-left:3px solid ${C.green}}

  ul.bul{margin:4px 0 2px;padding-left:20px}
  ul.bul li{margin:3px 0}

  ol.tl{list-style:none;margin:0;padding:0 0 0 4px}
  ol.tl li{position:relative;padding:0 0 14px 22px;border-left:2px solid ${C.slate200}}
  ol.tl li.last{border-left-color:transparent;padding-bottom:0}
  .tl-dot{position:absolute;left:-6px;top:5px;width:10px;height:10px;border-radius:50%;
    background:#fff;border:2.5px solid ${C.blue}}
  .tl-k{display:inline-block;min-width:132px;font-weight:600;font-size:13px}
  .tl-v{color:${C.slate600};font-size:12.5px;font-family:ui-monospace,Menlo,monospace}
  .tl-by{color:${C.blue};font-size:12px;margin-left:6px}

  ol.why{list-style:none;margin:0;padding:0}
  ol.why li{display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px dashed ${C.slate200}}
  ol.why li:last-child{border-bottom:none}
  .why-tag{flex:none;min-width:86px;font-size:11px;font-weight:700;text-transform:uppercase;
    letter-spacing:.04em;color:${C.purple};padding-top:2px}

  .chips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0}
  .chip{padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:600}
  .chip.blue{background:${C.blueL};color:#1e40af}
  .chip.green{background:${C.greenL};color:#065f46}
  .chip.amber{background:${C.amberL};color:#92400e}
  .chip.red{background:${C.redL};color:#991b1b}
  .chip.purple{background:${C.purpleL};color:#5b21b6}

  .callout{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;padding:11px 14px;border-radius:9px;
    font-size:13px;border:1px solid}
  .callout.ok{background:${C.greenL};border-color:${C.green};color:#065f46}
  .callout.warn{background:${C.amberL};border-color:${C.amber};color:#92400e}
  .callout.info{background:${C.blueL};border-color:${C.blue};color:#1e40af}

  footer{margin:22px 34px 0;padding-top:14px;border-top:1px solid ${C.slate200};
    color:${C.slate400};font-size:11.5px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}

  @media print{
    body{background:#fff}
    .sec{break-inside:avoid;box-shadow:none}
    header{border-bottom-width:3px}
  }
  @media (max-width:640px){
    header,.metrics,.sec,footer{margin-left:0;margin-right:0;padding-left:18px;padding-right:18px}
    .sec{border-radius:0}
    table.kv th{width:auto;display:block;padding-bottom:0}
    table.kv td{display:block;padding-top:2px}
  }
</style></head>
<body><div class="wrap">

<header>
  <div class="eyebrow">Root Cause Analysis</div>
  <h1>${esc(s.title)}</h1>
  <div class="sub">${esc(s.incidentNumber || s.id)}${s.itilPriority ? ` · ${esc(s.itilPriority)}` : ""} ·
    generated ${esc(fmtTs(new Date().toISOString()))} by TCS Agentic AI (autonomous detection)</div>
  <div class="hdr-row">
    <span class="badge sev">${esc(s.severity)}</span>
    <span class="badge state">${esc(stateLabel)}</span>
    ${aiBadge}
    ${s.selfHealed ? `<span class="badge" style="background:${C.greenL};color:#065f46">Self-healed</span>` : ""}
    ${s.reusedExistingTicket ? `<span class="badge" style="background:${C.cyanL};color:#155e75">Existing ticket reused</span>` : ""}
    ${s.occurrences > 1 ? `<span class="badge" style="background:${C.redL};color:#991b1b">Recurring ${esc(s.occurrences)}×</span>` : ""}
  </div>
</header>

${metrics.length ? `<div class="metrics">${metrics.map((m) => `
  <div class="metric"><b>${m.value}m</b><span>${m.label}</span><i>to ${m.hint}</i></div>`).join("")}
  <div class="metric"><b>${esc(s.symptomCount ?? 1)}</b><span>Symptoms</span><i>correlated</i></div>
</div>` : ""}

${section("1", "Summary", kv([
  ["Title", esc(s.title)],
  ["Severity", `<span class="chip ${SEV_TONE[s.severity] === SEV_TONE["SEV-5"] ? "green" : "red"}">${esc(s.severity)}</span>`],
  ["Cluster", `<code>${esc(s.cluster)}</code>`],
  ["Scope", s.namespace ? `namespace <code>${esc(s.namespace)}</code>${s.target ? ` · <code>${esc(s.target)}</code>` : ""}` : "cluster-wide"],
  s.node && ["Node", `<code>${esc(s.node)}</code>`],
  ["Detected by", `threshold <code>${esc(s.rule)}</code>${s.thresholdStandard ? ` (${esc(s.thresholdStandard)})` : ""}${s.dwellMinutes != null ? ` after ${esc(s.dwellMinutes)}m sustained` : ""}`],
  (s.signals?.length > 1) && ["Merged signals", chips(s.signals, "purple")],
  ["ServiceNow", s.incidentNumber ? `<code>${esc(s.incidentNumber)}</code>${s.ticketClosed ? " · closed with this RCA" : ""}` : "not raised"],
]))}

${section("2", "Impact", `
  ${r.impact ? `<p class="lead">${esc(r.impact)}</p>` : ""}
  <p class="muted">${esc(s.symptomCount ?? 1)} symptom(s) observed${s.correlation && s.correlation !== "single" ? ` and correlated as <strong>${esc(s.correlation)}</strong>` : ""}.${
    s.occurrences > 1 ? ` Recurring — seen ${esc(s.occurrences)} time(s), which makes this a Problem-record candidate.` : ""}</p>
`)}

${section("3", "Timeline", timelineHtml)}

${section("4", "Root cause", `
  <p class="lead">${esc(r.rootCause || "Under investigation")}</p>
  ${kv([
    r.category && ["Category", `<span class="chip purple">${esc(r.category)}</span>`],
    ["Determined by", r.aiAnalysed
      ? `AI analysis grounded in live logs, events and pod state${r.confidence ? ` · confidence <strong>${esc(r.confidence)}</strong>` : ""}`
      : `deterministic rules${r.aiUnavailableReason ? ` — ${esc(r.aiUnavailableReason)}` : ""}`],
    (r.deterministicRootCause && r.deterministicRootCause !== r.rootCause) && ["Rule-based signal", `<code>${esc(r.deterministicRootCause)}</code>`],
  ])}
  ${r.analysis ? `<h3>4.1 Detailed AI analysis</h3><p class="lead">${esc(r.analysis)}</p>` : ""}
  ${whyHtml ? `<h3>4.2 Causal chain (5-Whys)</h3>${whyHtml}` : ""}
  ${r.contributingFactors?.length ? `<h3>4.3 Contributing factors</h3>${bullets(r.contributingFactors)}` : ""}
  ${r.recommendation ? `<h3>4.4 Recommendation</h3><p>${esc(r.recommendation)}</p>` : ""}
`, { badge: `<span style="margin-left:auto">${aiBadge}</span>` })}

${section("5", "Evidence", evParts.join(""))}

${r.investigationSteps?.length ? section("6", "Further investigation if it recurs",
  `<ol>${r.investigationSteps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`) : ""}

${section("7", "Resolution", resolutionHtml)}

${section("8", "Verification", verHtml)}

${capa.length ? section("9", "Corrective &amp; preventive actions (CAPA)", bullets(capa)) : ""}

${section("10", "Notes", `
  <div class="callout info">
    <span><strong>Blameless review.</strong> Detection, root-cause analysis, ticketing, remediation and
    verification were performed automatically. ${s.approvedBy
      ? `A human (<strong>${esc(s.approvedBy)}</strong>) approved the corrective action before it was applied.`
      : s.selfHealed ? "The condition resolved itself; no corrective action was applied."
      : "No corrective action was applied."}</span>
  </div>
`)}

<footer>
  <span>TCS Agentic AI · UC-05 Zero-Touch Incident Command</span>
  <span>Session <code>${esc(s.id)}</code>${s.signature ? ` · correlation <code>${esc(s.signature)}</code>` : ""}</span>
</footer>

</div></body></html>`;
}

// ---------------------------------------------------------------------------
// PDF — for archival / e-mail / auditors who want a file rather than a link
// ---------------------------------------------------------------------------
const PDF_C = { navy: "#0f172a", blue: "#2563eb", slate: "#475569", red: "#dc2626", green: "#059669", amber: "#d97706" };

/**
 * Render the RCA as a PDF buffer. Deliberately typographic rather than a
 * pixel-copy of the HTML: PDF is for reading and filing, so it favours clear
 * hierarchy and reliable pagination over layout fidelity.
 * @returns {Promise<Buffer>}
 */
export function renderRCAPdf(s) {
  const r = s.rca || {};
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 50, bottom: 50, left: 50, right: 50 }, bufferPages: true });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width - 100;
    const h1 = (t) => { doc.moveDown(0.8).fontSize(13).font("Helvetica-Bold").fillColor(PDF_C.navy).text(t, { width: W }); doc.moveDown(0.25); };
    const h2 = (t) => { doc.moveDown(0.5).fontSize(10.5).font("Helvetica-Bold").fillColor(PDF_C.slate).text(t, { width: W }); doc.moveDown(0.15); };
    const p = (t) => { doc.fontSize(10).font("Helvetica").fillColor("#111827").text(String(t ?? "—"), { width: W }); };
    const kvp = (k, v) => {
      doc.fontSize(10).font("Helvetica-Bold").fillColor(PDF_C.slate).text(`${k}: `, { continued: true });
      doc.font("Helvetica").fillColor("#111827").text(String(v ?? "—"), { width: W });
    };
    const li = (t) => doc.fontSize(10).font("Helvetica").fillColor("#111827").text(`•  ${t}`, { width: W, indent: 6 });
    const mono = (lines) => {
      doc.moveDown(0.2);
      for (const l of lines) doc.fontSize(8.5).font("Courier").fillColor("#1f2937").text(String(l), { width: W });
      doc.moveDown(0.2);
    };

    // Title block
    doc.rect(0, 0, doc.page.width, 76).fill(PDF_C.navy);
    doc.fillColor("#7dd3fc").fontSize(8.5).font("Helvetica-Bold").text("ROOT CAUSE ANALYSIS", 50, 24);
    doc.fillColor("#ffffff").fontSize(15).font("Helvetica-Bold").text(String(s.title || ""), 50, 38, { width: W });
    doc.fillColor("#94a3b8").fontSize(8.5).font("Helvetica")
      .text(`${s.incidentNumber || s.id}${s.itilPriority ? ` · ${s.itilPriority}` : ""} · ${s.severity} · generated ${fmtTs(new Date().toISOString())} by TCS Agentic AI`, 50, 60, { width: W });
    doc.fillColor("#111827").y = 96;

    h1("1. Summary");
    kvp("Severity", s.severity);
    kvp("Cluster", s.cluster);
    kvp("Scope", s.namespace ? `namespace ${s.namespace}${s.target ? ` · ${s.target}` : ""}` : "cluster-wide");
    kvp("Detected by", `threshold "${s.rule}"${s.thresholdStandard ? ` (${s.thresholdStandard})` : ""}${s.dwellMinutes != null ? ` after ${s.dwellMinutes}m sustained` : ""}`);
    if (s.signals?.length > 1) kvp("Merged signals", s.signals.join(" → "));
    kvp("ServiceNow", s.incidentNumber || "not raised");

    h1("2. Impact");
    if (r.impact) p(r.impact);
    p(`${s.symptomCount ?? 1} symptom(s) observed${s.correlation && s.correlation !== "single" ? ` and correlated as "${s.correlation}"` : ""}.${s.occurrences > 1 ? ` Recurring — seen ${s.occurrences} time(s).` : ""}`);

    h1("3. Timeline");
    const mttd = mins(s.firstSeen, s.detectedAt), mtta = mins(s.detectedAt, s.approvedAt), mttr = mins(s.detectedAt, s.resolvedAt);
    for (const [k, v] of [["Condition began", s.firstSeen], ["Detected", s.detectedAt], ["Ticket raised", s.incidentRaisedAt],
      ["Fix dry-run", s.dryRunAt], ["Approved", s.approvedAt], ["Remediated", s.remediatedAt], ["Resolved", s.resolvedAt], ["Closed", s.closedAt]]) {
      if (v) kvp(k, fmtTs(v));
    }
    if (mttd != null || mtta != null || mttr != null) {
      kvp("Metrics", [mttd != null && `MTTD ${mttd}m`, mtta != null && `MTTA ${mtta}m`, mttr != null && `MTTR ${mttr}m`].filter(Boolean).join("  ·  "));
    }

    h1("4. Root cause");
    p(r.rootCause || "Under investigation");
    if (r.category) kvp("Category", r.category);
    kvp("Determined by", r.aiAnalysed
      ? `AI analysis grounded in live logs, events and pod state${r.confidence ? ` (confidence ${r.confidence})` : ""}`
      : `deterministic rules${r.aiUnavailableReason ? ` — ${r.aiUnavailableReason}` : ""}`);
    if (r.analysis) { h2("4.1 Detailed AI analysis"); p(r.analysis); }
    const why = (r.whyChain?.length ? r.whyChain : (r.causalChain || []).map((c) => c.cause || c.evidence)).filter(Boolean);
    if (why.length) { h2("4.2 Causal chain (5-Whys)"); why.forEach((w, i) => li(`${i === 0 ? "Symptom" : i === why.length - 1 ? "Root cause" : `Why ${i}`}: ${w}`)); }
    if (r.contributingFactors?.length) { h2("4.3 Contributing factors"); r.contributingFactors.forEach(li); }
    if (r.recommendation) { h2("4.4 Recommendation"); p(r.recommendation); }

    h1("5. Evidence");
    h2("5.1 Threshold observations");
    (r.evidence || []).forEach(li);
    if (r.restarts) li(`Total container restarts: ${r.restarts}`);
    for (const x of r.exitCodes || []) li(`Container "${x.container}" terminated: ${x.reason || "?"} (exit ${x.code ?? "?"})`);
    if (r.limits?.length) { h2("5.2 Resource configuration"); r.limits.forEach((l) => li(`${l.container}: limits=${JSON.stringify(l.limits)} requests=${JSON.stringify(l.requests)}`)); }
    h2("5.3 Log evidence");
    if (r.logLines?.length) mono(r.logLines.slice(0, 18)); else p("No error output captured.");
    if (r.events?.length) { h2("5.4 Kubernetes warning events"); r.events.forEach((e) => li(`[${e.reason}] ${e.message}`)); }
    if (r.kbMatches?.length) { h2("5.5 Known-error matches"); r.kbMatches.forEach((m) => li(`${m.rootCause || "match"}${m.remediation ? ` → ${m.remediation}` : ""}`)); }
    if (r.investigationSteps?.length) { h1("6. Further investigation if it recurs"); r.investigationSteps.forEach((x, i) => li(`${i + 1}. ${x}`)); }

    h1("7. Resolution");
    if (s.remediation?.command) {
      kvp("Action", `${s.remediation.action} (risk ${s.remediation.risk}, ${s.remediation.reversible ? "reversible" : "NOT reversible"})`);
      kvp("Approved by", s.approvedBy || "—");
      if (s.remediation.rationale) p(s.remediation.rationale);
      h2("Command executed"); mono([`$ ${s.remediation.command}`]);
      if (s.dryRunOutput) { h2("Dry-run output"); mono([String(s.dryRunOutput)]); }
      if (s.applyOutput) { h2("Apply output"); mono([String(s.applyOutput)]); }
    } else {
      p(`No safe automated remediation was available; the incident was escalated for human action.${s.escalationReason ? ` ${s.escalationReason}` : ""}`);
    }

    h1("8. Verification");
    if (s.verification) {
      doc.fontSize(10).font("Helvetica-Bold").fillColor(s.verification.ok ? PDF_C.green : PDF_C.amber)
        .text(s.verification.ok ? "VERIFIED" : "NOT VERIFIED", { continued: true });
      doc.font("Helvetica").fillColor("#111827").text(`  ${s.verification.summary}`, { width: W });
    } else p("Not verified.");
    if (s.afterSnapshot?.rows?.length) {
      h2("Container status after fix");
      mono([s.afterSnapshot.header.join("   "), ...s.afterSnapshot.rows.map((x) => `${x.name}   ${x.ready}   ${x.status}   ${x.restarts}   ${x.age}`)]);
    }

    const capa = [...(r.preventiveActions || []), ...(s.occurrences > 1 ? [`Recurring ${s.occurrences}× — raise a Problem record for a permanent fix.`] : [])];
    if (capa.length) { h1("9. Corrective & preventive actions"); capa.forEach(li); }

    h1("10. Notes");
    p(`Blameless review. Detection, root-cause analysis, ticketing, remediation and verification were performed automatically. ${
      s.approvedBy ? `A human (${s.approvedBy}) approved the corrective action before it was applied.`
      : s.selfHealed ? "The condition resolved itself; no corrective action was applied." : "No corrective action was applied."}`);

    doc.moveDown(1).fontSize(8).font("Helvetica").fillColor("#94a3b8")
      .text(`TCS Agentic AI · UC-05 Zero-Touch Incident Command · session ${s.id}${s.signature ? ` · correlation ${s.signature}` : ""}`, { width: W });

    doc.end();
  });
}
