// ---------------------------------------------------------------------------
// The evidence pack
// ---------------------------------------------------------------------------
/**
 * A migration programme does not run on a screen. It runs on a document that
 * goes to a change board, gets attached to a ticket, and is read a year later
 * by an auditor asking why a machine was moved unsupported. That document has
 * to state what was assessed, when, against which matrix, by whom — and it has
 * to be the same every time it is opened.
 *
 * Two formats, both generated as plain strings so nothing here depends on a
 * library the runtime image may not carry:
 *   - CSV  for the per-VM register, which is what people actually work from.
 *   - HTML for the pack itself, which prints to PDF from any browser.
 *
 * Everything in this file is pure and takes an explicit clock, so the same
 * inputs produce the same bytes and the output can be tested exactly.
 */

const LEVEL_LABEL = {
  supported: "Ready", caveats: "With caveats", unknown: "Needs review", unsupported: "Blocked",
};

// ── CSV ────────────────────────────────────────────────────────────────────
/** RFC 4180: quote everything, double interior quotes. Also blocks CSV injection. */
export function csvCell(v) {
  let s = v == null ? "" : String(v);
  // A cell starting with = + - @ is executed as a formula by Excel and Sheets.
  // Guest OS strings and MTV messages come from outside this system.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
const csvRow = (cells) => cells.map(csvCell).join(",");

/**
 * The per-VM register. One row per machine, one column per fact a migration
 * engineer needs, and the required actions flattened so a spreadsheet filter
 * can find every VM that needs the same fix.
 */
export function toCsv(analysis, meta = {}) {
  const lines = [];
  // A provenance block above the header: a register with no context is a list
  // of names that could describe any estate on any day.
  lines.push(csvRow(["TCS Agentic AI — VM migration assessment"]));
  lines.push(csvRow(["Report", meta.reportId || ""]));
  lines.push(csvRow(["Generated", meta.at || ""]));
  lines.push(csvRow(["Source", meta.provider || ""]));
  lines.push(csvRow(["Target cluster", meta.cluster || ""]));
  lines.push(csvRow(["Guest matrix", analysis?.matrix?.asOf || ""]));
  lines.push(csvRow(["Assessed by", meta.actor || ""]));
  lines.push("");

  lines.push(csvRow([
    "VM", "Status", "Guest OS", "Support tier", "OS family", "Reported by vCenter",
    "IP addresses", "vCPU", "RAM GiB", "Storage GiB", "Powered on",
    "Warm eligible", "Recommended method", "Source VM during copy",
    "Required actions", "Advisory actions",
  ]));

  const advice = Object.fromEntries((meta.advice || []).map((a) => [a.name, a]));
  for (const r of analysis?.rows || []) {
    const a = advice[r.name] || {};
    const acts = r.actions || [];
    lines.push(csvRow([
      r.name,
      LEVEL_LABEL[r.level] || r.level,
      r.os?.distro || "",
      r.os?.tierLabel || "",
      r.os?.family || "",
      r.os?.reported || "",
      (r.ips || []).join(" "),
      r.cpuCount ?? "",
      r.memoryGiB ?? "",
      r.diskGiB ?? "",
      r.poweredOn ? "yes" : "no",
      r.warmEligible ? "yes" : "no",
      a.strategy || "",
      a.label || "",
      acts.filter((x) => x.required).map((x) => `${x.title}: ${x.action}`).join(" | "),
      acts.filter((x) => !x.required && x.severity !== "good").map((x) => `${x.title}: ${x.action}`).join(" | "),
    ]));
  }
  return lines.join("\r\n");
}

// ── HTML ───────────────────────────────────────────────────────────────────
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const LEVEL_COLOUR = {
  supported: "#0d9488", caveats: "#b45309", unknown: "#64748b", unsupported: "#b91c1c",
};

/**
 * The printable pack. Deliberately light-only and self-contained: this is a
 * document, not a screen — it will be printed, emailed and attached to a
 * ticket, and it must render identically wherever it lands.
 */
export function toHtml(analysis, meta = {}) {
  const advice = Object.fromEntries((meta.advice || []).map((a) => [a.name, a]));
  const rows = analysis?.rows || [];
  const byLevel = analysis?.byLevel || {};
  const cap = meta.capacity || null;
  const drift = meta.drift || null;

  const tile = (key, label) => `
    <div class="tile">
      <div class="tile-n" style="color:${LEVEL_COLOUR[key]}">${byLevel[key] || 0}</div>
      <div class="tile-l">${label}</div>
    </div>`;

  const vmRows = rows.map((r) => {
    const a = advice[r.name] || {};
    const acts = (r.actions || []).filter((x) => x.severity !== "good");
    return `
    <tr>
      <td class="b">${esc(r.name)}</td>
      <td style="color:${LEVEL_COLOUR[r.level] || "#64748b"};font-weight:700">${esc(LEVEL_LABEL[r.level] || r.level)}</td>
      <td>${esc(r.os?.distro || "—")}${r.os?.tierLabel ? `<br><span class="muted small">${esc(r.os.tierLabel)}</span>` : ""}</td>
      <td class="mono">${esc((r.ips || []).join(", ") || "—")}</td>
      <td class="n">${esc(r.cpuCount ?? "—")}</td>
      <td class="n">${r.memoryGiB ? esc(r.memoryGiB) + " GiB" : "—"}</td>
      <td class="n">${r.diskGiB ? esc(r.diskGiB) + " GiB" : "—"}</td>
      <td>${esc(a.strategy || "—")}${a.label ? ` · ${esc(a.label)}` : ""}</td>
      <td>${acts.length
        ? `<ul>${acts.map((x) => `<li>${x.required ? "<b>[required]</b> " : ""}${esc(x.title)} — ${esc(x.action)}</li>`).join("")}</ul>`
        : "<span class=\"muted\">Nothing to change.</span>"}</td>
    </tr>`;
  }).join("");

  const findings = (meta.suggestions || []).map((s) => `
    <li><b>${esc(s.title)}</b>${s.detail ? ` — ${esc(s.detail)}` : ""}<br><span class="muted">→ ${esc(s.action)}</span></li>`).join("");

  const capacityBlock = cap ? `
    <h2>Target capacity</h2>
    <p class="verdict ${esc(cap.verdict)}">${esc(cap.headline)}</p>
    <table class="kv">
      <tr><th>This wave requires</th><td>${esc(cap.demand?.memGiB)} GiB RAM · ${esc(cap.demand?.cpuMillis)}m CPU · ${esc(cap.demand?.diskGiB)} GiB storage</td></tr>
      <tr><th>Unreserved on virtualization nodes</th><td>${esc(cap.free?.memGiB)} GiB RAM · ${esc(cap.free?.cpuMillis)}m CPU across ${esc(cap.virtNodeCount)} node(s)</td></tr>
      ${cap.largestNode ? `<tr><th>Largest single node</th><td>${esc(cap.largestNode.name)} — ${esc(cap.largestNode.memGiB)} GiB, ${esc(cap.largestNode.cpuMillis)}m</td></tr>` : ""}
    </table>
    ${(cap.perVm || []).some((p) => p.permanent) ? `
      <p><b>Machines that can never schedule on this cluster:</b></p>
      <ul>${cap.perVm.filter((p) => p.permanent).map((p) => `<li><b>${esc(p.name)}</b> — ${esc(p.reason)}</li>`).join("")}</ul>` : ""}
    ${(cap.perVm || []).some((p) => p.fits === false && !p.permanent) ? `
      <p><b>Machines that fit the hardware but have no room today:</b></p>
      <ul>${cap.perVm.filter((p) => p.fits === false && !p.permanent).map((p) => `<li><b>${esc(p.name)}</b> — ${esc(p.reason)}</li>`).join("")}</ul>` : ""}
    <ul class="muted small">${(cap.notes || []).map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";

  const driftBlock = drift ? `
    <h2>Change since the previous assessment</h2>
    <p>${esc(drift.headline)} <span class="muted">(baseline ${esc(drift.sinceReportId)}, ${esc(drift.since)})</span></p>
    ${["added", "removed", "improved", "regressed", "changed"].map((k) => (
      drift[k]?.length
        ? `<p class="b">${k[0].toUpperCase() + k.slice(1)}</p><ul>${drift[k].map((d) => `<li><b>${esc(d.name)}</b> — ${esc(d.note)}</li>`).join("")}</ul>`
        : ""
    )).join("")}` : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(meta.reportId || "Migration assessment")} — VM migration assessment</title>
<style>
  :root { color-scheme: light; }
  body { font: 13px/1.5 "Inter", -apple-system, "Segoe UI", system-ui, sans-serif; color: #1e293b; background: #fff; margin: 0; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 15px; margin: 26px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #e5e7eb; }
  .sub { color: #64748b; margin: 0 0 18px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eef1f6; vertical-align: top; }
  thead th { background: #f6f8fc; border-bottom: 1px solid #e5e7eb; white-space: nowrap; }
  table.kv { width: auto; } table.kv th { background: none; color: #64748b; font-weight: 600; padding-right: 18px; }
  .tiles { display: flex; gap: 10px; margin: 12px 0 4px; }
  .tile { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 16px; min-width: 110px; }
  .tile-n { font-size: 26px; font-weight: 800; line-height: 1.1; }
  .tile-l { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; font-weight: 700; }
  .b { font-weight: 700; } .n { text-align: right; white-space: nowrap; }
  .muted { color: #64748b; } .small { font-size: 11px; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; }
  ul { margin: 4px 0; padding-left: 18px; }
  .verdict { font-weight: 700; padding: 8px 11px; border-radius: 8px; border: 1px solid #e5e7eb; }
  .verdict.fits { color: #0d9488; border-color: #99f6e4; background: #f0fdfa; }
  .verdict.tight { color: #b45309; border-color: #fde68a; background: #fffbeb; }
  .verdict.exceeds, .verdict.blocked { color: #b91c1c; border-color: #fecaca; background: #fef2f2; }
  footer { margin-top: 30px; padding-top: 10px; border-top: 1px solid #e5e7eb; color: #64748b; font-size: 11px; }
  @media print { body { padding: 0; } thead { display: table-header-group; } tr { break-inside: avoid; } }
</style></head><body>
<h1>VM migration assessment</h1>
<p class="sub">${esc(meta.reportId || "")} · generated ${esc(meta.at || "")}</p>

<table class="kv">
  <tr><th>Source platform</th><td>${esc(meta.provider || "—")}</td></tr>
  <tr><th>Target cluster</th><td>${esc(meta.cluster || "—")}</td></tr>
  <tr><th>Guest support matrix</th><td>${esc(analysis?.matrix?.asOf || "—")}</td></tr>
  <tr><th>Assessed by</th><td>${esc(meta.actor || "—")}</td></tr>
</table>

<h2>Summary</h2>
<div class="tiles">
  ${tile("supported", "Ready")}${tile("caveats", "With caveats")}${tile("unknown", "Needs review")}${tile("unsupported", "Blocked")}
</div>
<p>${esc(analysis?.total || 0)} virtual machines · ${esc(analysis?.totalCpu || 0)} vCPU ·
   ${esc(analysis?.totalMemoryGiB || 0)} GiB RAM · ${esc(analysis?.totalDiskGiB || 0)} GiB storage ·
   ${esc(analysis?.warmEligible || 0)} eligible for warm migration.</p>

${capacityBlock}

<h2>Findings</h2>
<ul>${findings || "<li>No findings recorded.</li>"}</ul>

${driftBlock}

<h2>Machine register</h2>
<table>
  <thead><tr>
    <th>VM</th><th>Status</th><th>Guest OS</th><th>IP address</th><th>vCPU</th><th>RAM</th><th>Storage</th><th>Method</th><th>What to change</th>
  </tr></thead>
  <tbody>${vmRows}</tbody>
</table>

<footer>
  Support levels combine Red Hat's certified guest operating system list for OpenShift Virtualization
  (read ${esc(analysis?.matrix?.asOf || "undated")}) with MTV's own validation of each machine.
  Red Hat publishes three tiers — certified (Red Hat supports you on it), vendor supported (the OS vendor does),
  and known to run (it boots, nobody certifies it). ${esc(analysis?.matrix?.source || "")}
  ${analysis?.matrix?.url ? `<a href="${esc(analysis.matrix.url)}">${esc(analysis.matrix.url)}</a>` : ""}
  Capacity figures are based on pod requests reserved on virtualization-capable nodes at the time of assessment,
  not on live utilisation. This report describes the estate as it was at ${esc(meta.at || "the time of generation")};
  re-run before acting on it if the source has changed since.
</footer>
</body></html>`;
}
