// ---------------------------------------------------------------------------
// The evidence pack
// ---------------------------------------------------------------------------
/**
 * A containerisation assessment does not end on a screen. It ends in a document
 * that goes to an architecture board, gets attached to a business case, and is
 * read a year later by somebody asking why a machine was left as a VM.
 *
 * Two formats, generated as plain strings so nothing depends on a library the
 * runtime image may not carry:
 *   - CSV  for the register, which is what people actually work from.
 *   - HTML for the pack, which prints to PDF from any browser.
 *
 * The rule that makes it worth keeping: THE UNREAD MACHINES ARE IN THE
 * DOCUMENT. Every assessment tool's report lists what it found. This one also
 * lists what it could not see and why, because a register that quietly omits
 * a third of an estate is how a programme gets planned against a number that
 * was never true.
 *
 * Pure, and takes an explicit clock, so the same inputs produce the same bytes.
 */

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A cell starting with = + - @ is executed as a formula by Excel and Sheets. */
export function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
const row = (cells) => cells.map(csvCell).join(",");

const VERDICT_LABEL = {
  "container-ready": "Containerisation candidate",
  "container-with-work": "Containerisable with work",
  "vm-only": "Keep as a VM",
  inconclusive: "Nothing recognisable running",
  unreadable: "NOT ASSESSED — could not read inside",
  "powered-off": "NOT ASSESSED — powered off",
};

/**
 * The per-machine register.
 *
 * One row per DISTINCT machine, with the clusters it was seen in — so an estate
 * assessed from a hub and a DR site produces one row, not two, and the row says
 * where it was seen.
 */
export function toCsv(fleet, meta = {}) {
  const lines = [];
  lines.push(row(["TCS Agentic AI — containerisation assessment"]));
  lines.push(row(["Generated", meta.at || ""]));
  lines.push(row(["Assessed by", meta.actor || ""]));
  lines.push(row(["Clusters", (meta.clusters || []).join(" | ")]));
  lines.push(row(["Observations", String(fleet?.observations ?? "")]));
  lines.push(row(["Distinct machines", String(fleet?.distinct ?? "")]));
  lines.push(row(["Candidates", `${fleet?.funnel?.candidates ?? 0} (${fleet?.funnel?.candidatePctOfEstate ?? 0}% of estate, ${fleet?.funnel?.candidatePctOfAssessed ?? 0}% of those that answered)`]));
  lines.push(row(["Not assessed", String(fleet?.funnel?.notAssessed ?? 0)]));
  // The provenance a reader needs to judge the whole document.
  lines.push(row(["Guest credential supplied", meta.credentialSupplied ? "yes" : "no"]));
  lines.push(row(["Dependency data supplied", fleet?.dependencies?.supplied ? "yes" : "no"]));
  lines.push(row(["Method", "Read through VMware Tools. Nothing executed in any guest; nothing installed. Listening ports, unit files, packages and config were NOT read."]));
  lines.push(row([]));

  lines.push(row(["Machine", "Verdict", "Runtimes", "Clusters", "Duplicate", "Blockers", "Required work", "Not read", "Summary"]));
  for (const m of fleet?.machines || []) {
    const r = m.result || {};
    lines.push(row([
      m.name,
      VERDICT_LABEL[r.verdict] || r.verdict,
      (r.runtimes || []).map((x) => x.label).join("; "),
      (m.clusters || []).join("; "),
      m.duplicated ? (m.conflicting ? "yes — verdicts disagreed" : "yes") : "",
      (r.blockers || []).map((b) => b.title).join(" | "),
      (r.concerns || []).filter((c) => c.required).map((c) => c.title).join(" | "),
      (r.unchecked || []).map((u) => u.fact).join("; "),
      r.summary,
    ]));
  }
  return lines.join("\n");
}

/** The printable pack. */
export function toHtml(fleet, meta = {}) {
  const f = fleet?.funnel || {};
  const p = fleet?.portfolio || {};
  const machines = fleet?.machines || [];
  const assessed = machines.filter((m) => !/unreadable|powered-off/.test(m.result?.verdict || ""));
  const notAssessed = machines.filter((m) => /unreadable|powered-off/.test(m.result?.verdict || ""));

  const machineRow = (m) => {
    const r = m.result || {};
    const work = [...(r.blockers || []), ...(r.concerns || []).filter((c) => c.required)];
    return `<tr>
      <td class="b">${esc(m.name)}${m.duplicated ? `<br><span class="muted small">seen in ${esc((m.clusters || []).join(", "))}${m.conflicting ? " — verdicts disagreed" : ""}</span>` : ""}</td>
      <td class="v-${esc(r.verdict)}">${esc(VERDICT_LABEL[r.verdict] || r.verdict)}</td>
      <td>${esc((r.runtimes || []).map((x) => x.label).join(", ") || "—")}</td>
      <td>${work.length
        ? `<ul>${work.map((w) => `<li><b>${esc(w.title)}</b>${w.action ? `<br><span class="muted">→ ${esc(w.action)}</span>` : ""}</li>`).join("")}</ul>`
        : '<span class="muted">Nothing found in what was read.</span>'}</td>
    </tr>`;
  };

  return `<!doctype html><html><head><meta charset="utf-8">
<title>Containerisation assessment${meta.at ? ` — ${esc(meta.at)}` : ""}</title>
<style>
 body{font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1f2b;margin:0;padding:36px;max-width:1100px}
 h1{font-size:23px;margin:0 0 4px} h2{font-size:16px;margin:30px 0 10px;border-bottom:1px solid #e4e8f1;padding-bottom:6px}
 .muted{color:#5a6373} .small{font-size:12px} .b{font-weight:600}
 table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px}
 th{text-align:left;padding:7px 8px;border-bottom:2px solid #e4e8f1;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#5a6373}
 td{padding:8px;border-bottom:1px solid #eef1f7;vertical-align:top}
 ul{margin:0;padding-left:16px} li{margin-bottom:4px}
 .tiles{display:flex;gap:26px;margin:16px 0 8px;flex-wrap:wrap}
 .tile-n{font-size:30px;font-weight:800;line-height:1.1} .tile-l{font-size:12px;color:#5a6373}
 .v-container-ready{color:#15803d;font-weight:700} .v-container-with-work{color:#b45309;font-weight:700}
 .v-vm-only{color:#3730a3;font-weight:700} .v-inconclusive,.v-unreadable,.v-powered-off{color:#64748b;font-weight:700}
 .note{background:#f7f9fc;border:1px solid #e4e8f1;border-radius:8px;padding:12px 14px;margin:12px 0}
 @media print{body{padding:0}.note{break-inside:avoid}table{break-inside:auto}tr{break-inside:avoid}}
</style></head><body>
<h1>Containerisation assessment</h1>
<div class="muted small">${esc(meta.at || "")}${meta.actor ? ` · ${esc(meta.actor)}` : ""}${(meta.clusters || []).length ? ` · ${esc((meta.clusters || []).join(", "))}` : ""}</div>

<div class="tiles">
  <div><div class="tile-n">${f.candidatePctOfEstate ?? 0}%</div><div class="tile-l">${f.candidates ?? 0} of ${f.total ?? 0} — of the estate</div></div>
  <div><div class="tile-n" style="color:#5a6373">${f.candidatePctOfAssessed ?? 0}%</div><div class="tile-l">${f.candidates ?? 0} of ${f.assessed ?? 0} — of what answered</div></div>
  <div><div class="tile-n" style="color:#5a6373">${f.notAssessed ?? 0}</div><div class="tile-l">not assessed</div></div>
</div>
<div class="note">${esc(f.note || "")} ${esc(fleet?.note || "")}</div>

<div class="note"><b>How this was read.</b> Through VMware Tools, using the credential the migration toolkit already holds.
Nothing was executed inside any guest and nothing was installed. Listening ports, systemd units, installed packages,
scheduled jobs, kernel modules and configuration files were <b>not read</b> — every verdict below is bounded by that,
and confidence is capped accordingly.${fleet?.dependencies?.supplied ? "" : " No dependency data was supplied, so nothing is known about what these machines talk to."}</div>

<h2>Where the work sits</h2>
<div class="muted">${esc(p.note || "")}</div>
<table><thead><tr><th>Reason</th><th>Machines</th><th>Examples</th></tr></thead><tbody>
${(p.topBlockers || []).map((b) => `<tr><td class="b">${esc(b.title)}</td><td>${b.count}</td><td class="muted small">${esc((b.machines || []).join(", "))}</td></tr>`).join("")}
</tbody></table>

<h2>Assessed — ${assessed.length}</h2>
<table><thead><tr><th>Machine</th><th>Verdict</th><th>Runtime</th><th>What has to happen</th></tr></thead><tbody>
${assessed.map(machineRow).join("")}
</tbody></table>

${notAssessed.length ? `<h2>Not assessed — ${notAssessed.length}</h2>
<div class="note">These machines are in this document deliberately. They are counted as neither candidates nor
blocked, and a register that omitted them would describe an estate that does not exist.</div>
<table><thead><tr><th>Machine</th><th>Verdict</th><th>Runtime</th><th>Reason</th></tr></thead><tbody>
${notAssessed.map((m) => `<tr><td class="b">${esc(m.name)}</td><td class="v-${esc(m.result?.verdict)}">${esc(VERDICT_LABEL[m.result?.verdict] || "")}</td><td>—</td><td class="muted">${esc(m.result?.summary || "")}</td></tr>`).join("")}
</tbody></table>` : ""}

${(fleet?.conflicts || []).length ? `<h2>Disagreements between clusters — ${fleet.conflicts.length}</h2>
<table><thead><tr><th>Machine</th><th>Seen as</th><th>Resolved to</th><th>Why</th></tr></thead><tbody>
${fleet.conflicts.map((c) => `<tr><td class="b">${esc(c.name)}</td><td class="small">${esc(c.seenIn.map((s) => `${s.cluster}: ${s.verdict}`).join("; "))}</td><td>${esc(VERDICT_LABEL[c.resolved] || c.resolved)}</td><td class="muted">${esc(c.why)}</td></tr>`).join("")}
</tbody></table>` : ""}

${(fleet?.possible || []).length ? `<h2>Possible duplicates — confirm before trusting the count</h2>
<table><thead><tr><th>Machine</th><th>Matched on</th><th>Seen in</th></tr></thead><tbody>
${fleet.possible.map((x) => `<tr><td class="b">${esc(x.name)}</td><td>${esc(x.basis)} (${esc(x.confidence)})</td><td class="small">${esc(x.seenIn.map((s) => s.cluster).join(", "))}</td></tr>`).join("")}
</tbody></table>` : ""}

${(fleet?.dependencies?.crossings || []).length ? `<h2>Dependencies crossing the two destinations</h2>
<table><thead><tr><th>From</th><th>To</th><th>Port</th><th>Why it matters</th></tr></thead><tbody>
${fleet.dependencies.crossings.map((c) => `<tr><td class="b">${esc(c.from)}</td><td class="b">${esc(c.to)}</td><td>${esc(c.port ?? "—")}</td><td class="muted">${esc(c.note)}</td></tr>`).join("")}
</tbody></table>` : ""}

<h2>Method and limits</h2>
<ul>
 <li>Verdicts come from fixed rules over the process list, not from a model. Each finding carries the process line it was drawn from.</li>
 <li>Confidence is capped: the facts that would raise it cannot be read without executing something inside the guest, which this assessment does not do.</li>
 <li>A machine that could not be read is reported as not assessed. It is never counted as having no blockers.</li>
 <li>Candidate rates are given twice — against the whole estate and against the machines that answered. The second is the figure usually quoted.</li>
</ul>
</body></html>`;
}
