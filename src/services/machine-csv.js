// ---------------------------------------------------------------------------
// The machine list as a spreadsheet
// ---------------------------------------------------------------------------
/**
 * CSV is not a fallback, it is how half of this work actually arrives.
 *
 * MTA offers it as a first-class way into the application inventory, with a
 * downloadable template, and it is the reason: an estate that is not VMware,
 * a vCenter nobody will give the product credentials to this quarter, a CMDB
 * extract, a list a customer maintains in Excel because that is where their
 * estate has lived for nine years. Refusing those and insisting on a live
 * vCenter connection is how an assessment tool never gets run at all.
 *
 * So the machine list round-trips: export what was discovered, hand it to
 * somebody, take it back with corrections, assess from it.
 *
 * The import is deliberately forgiving about SHAPE and strict about MEANING:
 * column order does not matter, headers are matched case- and
 * punctuation-insensitively, and a row missing a name is rejected with its
 * line number rather than silently becoming a machine called "undefined".
 *
 * Everything here is pure.
 */

/** A cell starting with = + - @ is executed as a formula by Excel and Sheets. */
export function cell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** The columns, in the order a human wants to read them. */
export const COLUMNS = Object.freeze([
  { key: "name", header: "Name", required: true },
  { key: "id", header: "Managed object id" },
  { key: "biosUuid", header: "BIOS UUID" },
  { key: "guestOS", header: "Guest OS" },
  { key: "powerState", header: "Power state" },
  { key: "cpuCount", header: "vCPU" },
  { key: "memoryGiB", header: "Memory GiB" },
  { key: "hostname", header: "Hostname" },
  { key: "ipAddress", header: "Address" },
]);

/** Export. What comes out imports back in without editing. */
export function toMachineCsv(vms = [], meta = {}) {
  const lines = [];
  if (meta.note) lines.push(cell(meta.note));
  if (meta.source) lines.push(`${cell("Source")},${cell(meta.source)}`);
  if (meta.at) lines.push(`${cell("Exported")},${cell(meta.at)}`);
  if (lines.length) lines.push("");
  lines.push(COLUMNS.map((c) => cell(c.header)).join(","));
  for (const v of vms) lines.push(COLUMNS.map((c) => cell(v[c.key])).join(","));
  return lines.join("\n");
}

/** A blank template, so somebody can start from the right columns. */
export function csvTemplate() {
  return [
    cell("Machines to assess. One row per machine. Name is the only required column."),
    "",
    COLUMNS.map((c) => cell(c.header)).join(","),
    COLUMNS.map((c) => cell(c.key === "name" ? "example-vm-01" : "")).join(","),
  ].join("\n");
}

/**
 * Split one CSV line, honouring quotes and doubled quotes.
 *
 * Written out rather than split(",") because a guest OS string contains commas
 * — "Red Hat Enterprise Linux 9 (64-bit), 64-bit" — and a naive split turns
 * one machine into two columns of nonsense with no error anywhere.
 */
export function splitCsvLine(line) {
  const out = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  // Excel's formula guard on the way back out again.
  return out.map((s) => s.trim().replace(/^'(?=[=+\-@])/, ""));
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Header synonyms, because nobody's spreadsheet uses our words. */
const ALIASES = {
  name: ["name", "vmname", "machine", "machinename", "vm", "hostname"],
  id: ["managedobjectid", "moref", "id", "vmid"],
  biosUuid: ["biosuuid", "uuid", "smbiosuuid"],
  guestOS: ["guestos", "os", "operatingsystem", "guestoperatingsystem"],
  powerState: ["powerstate", "state", "power"],
  cpuCount: ["vcpu", "cpu", "cpus", "cpucount", "numcpu"],
  memoryGiB: ["memorygib", "memory", "ram", "memorygb", "ramgb"],
  hostname: ["hostname", "fqdn", "dnsname"],
  ipAddress: ["address", "ip", "ipaddress"],
};

/**
 * Import.
 *
 * @returns {{vms:Array, rejected:Array, header:object, note:string}}
 *   rejected rows carry their line number, because "3 rows were ignored" with
 *   no line numbers is a message that cannot be acted on.
 */
export function parseMachineCsv(text = "") {
  const raw = String(text).replace(/^﻿/, "").split(/\r?\n/);
  // Find the header: the first line that carries a recognisable name column.
  // Skipped over whatever provenance block an export wrote above it, so a file
  // we produced imports back without anyone having to trim it.
  let headerAt = -1, cols = null;
  for (let i = 0; i < raw.length; i++) {
    if (!raw[i].trim()) continue;
    const parts = splitCsvLine(raw[i]).map(norm);
    const mapped = parts.map((p) => Object.keys(ALIASES).find((k) => ALIASES[k].includes(p)) || null);
    if (mapped.includes("name")) { headerAt = i; cols = mapped; break; }
  }
  if (headerAt === -1) {
    return { vms: [], rejected: [], header: null,
      note: "No header row with a Name column was found. Download the template, or make sure one column is called Name." };
  }

  const vms = [], rejected = [];
  for (let i = headerAt + 1; i < raw.length; i++) {
    const line = raw[i];
    if (!line.trim()) continue;
    const parts = splitCsvLine(line);
    const vm = {};
    parts.forEach((v, j) => { const k = cols[j]; if (k && v !== "") vm[k] = v; });

    if (!vm.name) { rejected.push({ line: i + 1, reason: "No name in this row.", raw: line.slice(0, 120) }); continue; }
    // Numbers, where they are numbers. A vCPU column of "4 vCPU" is a string
    // and is left alone rather than coerced to NaN.
    for (const k of ["cpuCount", "memoryGiB"]) {
      if (vm[k] != null) { const n = Number(vm[k]); if (Number.isFinite(n)) vm[k] = n; }
    }
    if (vm.powerState) vm.poweredOn = /on/i.test(vm.powerState);
    vm.source = "csv";
    vms.push(vm);
  }

  const withoutId = vms.filter((v) => !v.id && !v.biosUuid).length;
  return {
    vms, rejected,
    header: Object.fromEntries(cols.map((k, j) => [j, k]).filter(([, k]) => k)),
    note: [
      `${vms.length} machine${vms.length === 1 ? "" : "s"} read.`,
      rejected.length ? `${rejected.length} row${rejected.length === 1 ? "" : "s"} rejected.` : null,
      // The consequence, stated where it is decided rather than discovered
      // three screens later when every machine comes back unreadable.
      withoutId ? `${withoutId} carr${withoutId === 1 ? "ies" : "y"} neither a managed object id nor a BIOS UUID, so nothing can be read inside ${withoutId === 1 ? "it" : "them"} and ${withoutId === 1 ? "it" : "they"} cannot be de-duplicated across clusters.` : null,
    ].filter(Boolean).join(" "),
  };
}
