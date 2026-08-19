/**
 * Renders the sample requirement documents as .docx — real Word headings and
 * real Word tables, so the platform's docx parser (mammoth → sections/tables)
 * recovers exactly the structure the deterministic extractor reads. The
 * round-trip is pinned by test/unit/sample-docs.test.js: md and docx must
 * extract identically.
 *
 * Run: node docs/sample-requirements/generate-docx.cjs [file.md ...]
 * (no args = all sample docs in this directory)
 */
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, WidthType, ShadingType, BorderStyle,
} = require("docx");

const DIR = __dirname;
const NAVY = "1E293B";
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" };
const TABLE_WIDTH = 9360; // US Letter minus 1" margins, in DXA

/** Markdown → [{h:level,text} | {table:{headers,rows}} | {p:text}] */
function parseMd(md) {
  const out = [];
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) { out.push({ h: h[1].length, text: h[2].trim() }); i++; continue; }
    if (/^\|.*\|\s*$/.test(line)) {
      const block = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { block.push(lines[i]); i++; }
      const rows = block
        .filter((r) => !/^\|[-: |]+\|\s*$/.test(r))
        .map((r) => r.replace(/^\||\|\s*$/g, "").split("|").map((c) => c.trim()));
      if (rows.length >= 1) out.push({ table: { headers: rows[0], rows: rows.slice(1) } });
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6})\s/.test(lines[i]) && !/^\|.*\|\s*$/.test(lines[i])) {
      para.push(lines[i].trim()); i++;
    }
    out.push({ p: para.join(" ").replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1") });
  }
  return out;
}

function makeTable({ headers, rows }) {
  const n = Math.max(1, headers.length);
  const colW = Array.from({ length: n }, () => Math.floor(TABLE_WIDTH / n));
  colW[n - 1] += TABLE_WIDTH - colW.reduce((a, b) => a + b, 0);

  const cell = (text, { header = false } = {}) => new TableCell({
    width: { size: colW[0], type: WidthType.DXA },
    borders: { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER },
    shading: header ? { type: ShadingType.CLEAR, fill: NAVY } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ children: [new TextRun({
      text: text || "",
      bold: header,
      color: header ? "FFFFFF" : undefined,
      size: 19,
    })] })],
  });

  return new Table({
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    columnWidths: colW,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h) => cell(h, { header: true })) }),
      ...rows.map((r) => new TableRow({
        children: Array.from({ length: n }, (_, ci) => cell(r[ci] ?? "")),
      })),
    ],
  });
}

const HEADING = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4 };

async function convert(mdFile) {
  const md = fs.readFileSync(mdFile, "utf8");
  const blocks = parseMd(md);
  const children = [];
  for (const b of blocks) {
    if (b.h) children.push(new Paragraph({ heading: HEADING[b.h] || HeadingLevel.HEADING_4, children: [new TextRun(b.text)], spacing: { before: 220, after: 120 } }));
    else if (b.table) children.push(makeTable(b.table), new Paragraph({ children: [] }));
    else if (b.p) children.push(new Paragraph({ children: [new TextRun(b.p)], spacing: { after: 120 } }));
  }
  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri", size: 21 } } } },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 } } }, // US Letter
      children,
    }],
  });
  const out = mdFile.replace(/\.md$/, ".docx");
  fs.writeFileSync(out, await Packer.toBuffer(doc));
  console.log(`Wrote ${path.basename(out)}`);
}

(async () => {
  const args = process.argv.slice(2);
  const files = args.length
    ? args
    : fs.readdirSync(DIR).filter((f) => /^\d\d-.*\.md$/.test(f)).map((f) => path.join(DIR, f));
  for (const f of files) await convert(f);
})();
