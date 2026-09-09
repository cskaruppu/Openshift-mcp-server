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
  // What the AI was and was not allowed to decide, in the same block as the
  // rest of the provenance — a register read in a year needs this on the page,
  // not in a system nobody kept.
  const ai = meta.ai || analysis?.ai || null;
  if (ai) {
    lines.push(csvRow(["AI consulted", ai.consulted ? "yes" : "no"]));
    if (ai.consulted) {
      lines.push(csvRow(["AI provider / model", `${ai.provider || "?"} / ${ai.model || "?"}`]));
      lines.push(csvRow(["AI calls", `${ai.calls}${ai.failed ? ` (${ai.failed} failed)` : ""}`]));
      lines.push(csvRow(["AI tokens", ai.totalTokens == null ? "not reported by the provider" : String(ai.totalTokens)]));
      lines.push(csvRow(["AI recommendations overruled", String(ai.corrections)]));
      lines.push(csvRow(["Advised by AI", ai.advisedByAI.join(" | ")]));
    }
    lines.push(csvRow(["Decided by code, not AI", ai.decidedByCode.join(" | ")]));
  }
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

  // The section a change board and an auditor both go looking for.
  const ai = meta.ai || analysis?.ai || null;
  const aiBlock = ai ? `
    <h2>AI provenance</h2>
    <!-- Neutral, deliberately: consulting a model is neither a warning nor an
         achievement. The verdict colours belong to capacity, not to this. -->
    <p class="verdict">${ai.consulted
      ? `A language model was consulted ${esc(ai.calls)} time${ai.calls === 1 ? "" : "s"} during this assessment. It advised; it did not decide.`
      : "No language model was consulted. Every value in this assessment came from rules."}</p>
    ${ai.consulted ? `
    <table class="kv">
      <tr><th>Provider and model</th><td>${esc(ai.provider || "—")} / ${esc(ai.model || "—")}</td></tr>
      <tr><th>Calls</th><td>${esc(ai.calls)}${ai.failed ? ` — ${esc(ai.failed)} failed and fell back to rules` : ""}</td></tr>
      <tr><th>Tokens</th><td>${ai.totalTokens == null
        ? "not reported by the provider"
        : `${esc(ai.totalTokens)} total (${esc(ai.promptTokens)} prompt, ${esc(ai.completionTokens)} completion)`}</td></tr>
      <tr><th>Model time</th><td>${esc(Math.round((ai.durationMs || 0) / 100) / 10)} s</td></tr>
      <tr><th>Recommendations overruled by policy</th><td>${esc(ai.corrections)}</td></tr>
    </table>
    <p><b>Advised by the model:</b></p>
    <ul>${ai.advisedByAI.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    <p><b>Decided by code, with no model involved:</b></p>
    <ul>${ai.decidedByCode.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    <p class="muted small">The model is given no cluster access and no tools. Every recommendation passes
    through a deterministic clamp before it is shown, and anything irreversible requires a person.</p>` : "";

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

${aiBlock}

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

/**
 * The document a change board actually needs attached to the request: what is
 * being migrated, how, how long it takes, what it costs in downtime, and what
 * a model touched.
 *
 * Built from the PLAN, not from whatever the browser was holding. A change
 * request raised days later from a fresh session carries the same document,
 * because the Plan carries the facts: the VM list, the source footprint
 * recorded at creation, the estimate and the rate it assumed, and the AI
 * provenance. Nothing here is re-derived from a source that may have moved.
 */
export function planReportHtml(plan = {}, meta = {}) {
  const spec = plan.spec || {};
  const ann = plan.metadata?.annotations || {};
  const warm = spec.warm === true;
  const name = plan.metadata?.name || "plan";
  const est = meta.est || null;
  const win = meta.window || null;

  let sourceVms = [];
  try { sourceVms = JSON.parse(ann["tcs.agentic-ai/source-vms"] || "[]"); } catch { sourceVms = []; }
  const byName = Object.fromEntries(sourceVms.map((v) => [v.n, v]));
  const vms = (spec.vms || []).map((v) => v.name || v.id).filter(Boolean);

  let ai = null;
  try { ai = JSON.parse(ann["tcs.agentic-ai/ai-provenance"] || "null"); } catch { ai = null; }

  const rows = vms.map((n) => {
    const s = byName[n] || {};
    return `<tr>
      <td class="mono">${esc(n)}</td>
      <td>${s.c ?? "—"}</td>
      <td>${s.m != null ? `${esc(s.m)} GiB` : "—"}</td>
      <td>${s.g != null ? `${esc(s.g)} GiB` : "—"}</td>
      <td>${s.d ?? "—"}</td>
      <td class="mono">${esc((s.i || []).join(", ") || "—")}</td>
    </tr>`;
  }).join("");

  const totalGiB = sourceVms.reduce((n, v) => n + (v.g || 0), 0) || Number(ann["tcs.agentic-ai/total-gib"] || 0);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(name)} — migration change record</title>
<style>
  body { font: 14px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1e293b; margin: 28px; max-width: 900px; }
  h1 { font-size: 19px; margin: 0 0 2px; } h2 { font-size: 15px; margin: 22px 0 7px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
  .sub { color: #475569; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th { text-align: left; background: #f1f5f9; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; }
  td { padding: 5px 8px; border-bottom: 1px solid #f1f5f9; }
  .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; }
  dl { display: grid; grid-template-columns: 210px 1fr; gap: 3px 12px; margin: 0; }
  dt { color: #475569; } dd { margin: 0; }
  pre { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 6px; padding: 9px 11px; font-size: 12.5px; white-space: pre-wrap; }
  footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #e5e7eb; color: #475569; font-size: 12px; }
</style></head><body>
<h1>${esc(name)}</h1>
<div class="sub">Migration to OpenShift Virtualization · ${warm ? "warm" : "cold"} · ${vms.length} virtual machine${vms.length === 1 ? "" : "s"} · ${esc(Math.round(totalGiB))} GiB</div>

<h2>What is being migrated</h2>
<table><thead><tr><th>Virtual machine</th><th>vCPU</th><th>Memory</th><th>Storage</th><th>Disks</th><th>IP address</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">No VMs recorded on the plan.</td></tr>'}</tbody></table>

<h2>How it moves</h2>
<dl>
  <dt>Strategy</dt><dd>${warm
    ? "Warm — the guest keeps serving users while its disks copy. The only downtime is the cutover at the end."
    : "Cold — the guest is powered off for the whole copy. The transfer is the outage."}</dd>
  <dt>Source provider</dt><dd>${esc(spec.provider?.source?.name || "—")}</dd>
  <dt>Target namespace</dt><dd>${esc(spec.targetNamespace || "—")}</dd>
  <dt>Storage map</dt><dd>${esc(spec.map?.storage?.name || "—")}</dd>
  <dt>Network map</dt><dd>${esc(spec.map?.network?.name || "—")}</dd>
</dl>

<h2>Time and impact</h2>
${est ? `<dl>
  <dt>Data to move</dt><dd>${esc(est.totalGiB)} GiB</dd>
  <dt>Estimated transfer</dt><dd>${esc(est.wallClockMinutes.likely)} min (${esc(est.wallClockMinutes.low)}–${esc(est.wallClockMinutes.high)})</dd>
  <dt>Expected service impact</dt><dd><b>${esc(est.downtimeMinutes.likely)} min</b> (${esc(est.downtimeMinutes.low)}–${esc(est.downtimeMinutes.high)})${warm ? " — the cutover only" : " — the whole copy"}</dd>
  <dt>Basis</dt><dd>${esc(est.throughputMBps)} MiB/s, ${est.measured
    ? `measured from ${esc(est.samples)} completed migration(s) on this cluster`
    : "a conservative default — this cluster has completed no migrations yet"}</dd>
</dl>` : "<p>The transfer time will be measured live once the migration starts.</p>"}
${win ? `<pre>${esc(win.basis)}</pre>` : ""}

<h2>Backing out</h2>
<p>${warm
  ? "Until the cutover the source VM keeps running and serving users — it is the way back at every moment before it. After the cutover the source is powered off and intact, and powering it back on restores service."
  : "The source VM is powered off for the copy and is never deleted. Powering it back on restores service."}
The migrated disks can be discarded; the migration only becomes irreversible when the source VMs are deleted, which is a separate change request raised after a soak period.</p>

<h2>What a model contributed</h2>
${ai?.consulted ? `<dl>
  <dt>Consulted</dt><dd>${esc(ai.provider || "?")} / ${esc(ai.model || "?")}, ${esc(ai.calls)} call(s)${ai.totalTokens != null ? `, ${esc(ai.totalTokens)} tokens` : ""}</dd>
  <dt>Advised on</dt><dd>${esc((ai.advisedByAI || []).join("; ") || "—")}</dd>
  <dt>Overruled by policy</dt><dd>${esc(ai.corrections || 0)} recommendation(s) corrected before being shown</dd>
</dl>` : "<p>No model was consulted. Every value in this record came from rules.</p>"}
<p>The model advises; code decides; a person approves. It has no cluster access and no tools, and the
supportability verdict, the readiness checks, the capacity check and the transfer estimate are all
computed rather than generated.</p>

<footer>
Generated by TCS Agentic AI from plan <span class="mono">${esc(name)}</span> at ${esc(meta.at || new Date().toISOString())}.
Every figure is read from the plan itself, so this record does not change if the source estate does.
</footer>
</body></html>`;
}
