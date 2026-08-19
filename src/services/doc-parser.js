/**
 * Document parser — extracts structured sections from .docx files.
 * Uses mammoth for Word document parsing.
 */

import mammoth from "mammoth";

/**
 * Parse a .docx buffer into structured sections.
 * Returns { sections: [{ heading, level, content, tables }], rawText }
 */
export async function parseDocx(buffer) {
  const result = await mammoth.convertToHtml({ buffer });
  const html = result.value;
  const rawResult = await mammoth.extractRawText({ buffer });
  const rawText = rawResult.value;

  const sections = [];
  let current = null;

  const headingRe = /<h(\d)[^>]*>(.*?)<\/h\d>/gi;
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  const tagRe = /<[^>]+>/g;

  const parts = html.split(/(?=<h[1-6])/i);

  for (const part of parts) {
    const hMatch = /^<h(\d)[^>]*>(.*?)<\/h\d>/i.exec(part);
    if (hMatch) {
      const level = parseInt(hMatch[1], 10);
      const heading = hMatch[2].replace(tagRe, "").trim();
      const body = part.slice(hMatch[0].length);

      const tables = [];
      let tMatch;
      while ((tMatch = tableRe.exec(body)) !== null) {
        tables.push(parseHtmlTable(tMatch[0]));
      }
      tableRe.lastIndex = 0;

      const content = body.replace(tableRe, "").replace(tagRe, " ").replace(/\s+/g, " ").trim();

      current = { heading, level, content, tables };
      sections.push(current);
    } else if (part.trim()) {
      const text = part.replace(tagRe, " ").replace(/\s+/g, " ").trim();
      if (text && current) {
        current.content += " " + text;
      } else if (text) {
        sections.push({ heading: "", level: 0, content: text, tables: [] });
      }
    }
  }

  return { sections, rawText };
}

function parseHtmlTable(tableHtml) {
  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  const tagRe = /<[^>]+>/g;

  let rMatch;
  while ((rMatch = rowRe.exec(tableHtml)) !== null) {
    const cells = [];
    let cMatch;
    while ((cMatch = cellRe.exec(rMatch[1])) !== null) {
      cells.push(cMatch[1].replace(tagRe, "").trim());
    }
    cellRe.lastIndex = 0;
    rows.push(cells);
  }

  if (rows.length < 2) return { headers: rows[0] || [], rows: [] };

  const headers = rows[0];
  const dataRows = rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] || "";
    });
    return obj;
  });

  return { headers, rows: dataRows };
}

/**
 * Render parsed sections back to markdown, tables included.
 *
 * The upload flow puts extracted text into the requirement textarea, and the
 * generate step re-parses that text as markdown. Flattening a .docx to plain
 * prose here silently discarded every table — and the tables ARE the
 * requirement grammar, so a Word document was quietly downgraded from the
 * deterministic path to the LLM path. Empty cells render as a single space:
 * the markdown table parser drops truly empty cells and shifts columns.
 */
export function sectionsToMarkdown(parsed) {
  const L = [];
  for (const sec of parsed.sections || []) {
    if (sec.heading) L.push(`${"#".repeat(Math.min(6, Math.max(1, sec.level || 1)))} ${sec.heading}`, "");
    if (sec.content && sec.content.trim()) L.push(sec.content.trim(), "");
    for (const t of sec.tables || []) {
      if (!t.headers?.length) continue;
      const cell = (v) => {
        const s = String(v ?? "").replace(/\|/g, "/").trim();
        return s === "" ? " " : s;
      };
      L.push(`| ${t.headers.map(cell).join(" | ")} |`);
      L.push(`|${t.headers.map(() => "---").join("|")}|`);
      for (const row of t.rows || []) {
        L.push(`| ${t.headers.map((h) => cell(row[h])).join(" | ")} |`);
      }
      L.push("");
    }
  }
  return L.join("\n");
}

/**
 * Parse plain text (markdown-like) into sections.
 * Fallback for when the user pastes text instead of uploading a file.
 */
export function parseMarkdownText(text) {
  const sections = [];
  const lines = text.split("\n");
  let current = null;

  for (const line of lines) {
    const hMatch = /^(#{1,6})\s+(.+)/.exec(line);
    if (hMatch) {
      current = { heading: hMatch[2].trim(), level: hMatch[1].length, content: "", tables: [] };
      sections.push(current);
    } else if (current) {
      current.content += line + "\n";
    }
  }

  // Parse markdown tables in each section
  for (const sec of sections) {
    const tableBlocks = sec.content.match(/\|[^\n]+\|\n\|[-: |]+\|\n(\|[^\n]+\|\n?)+/g);
    if (tableBlocks) {
      for (const block of tableBlocks) {
        const rows = block.trim().split("\n").filter((r) => !/^\|[-: |]+\|$/.test(r));
        if (rows.length >= 2) {
          const headers = rows[0].split("|").filter(Boolean).map((c) => c.trim());
          const data = rows.slice(1).map((r) => {
            const cells = r.split("|").filter(Boolean).map((c) => c.trim());
            const obj = {};
            headers.forEach((h, i) => { obj[h] = cells[i] || ""; });
            return obj;
          });
          sec.tables.push({ headers, rows: data });
        }
      }
    }
    sec.content = sec.content.replace(/\|[^\n]+\|\n\|[-: |]+\|\n(\|[^\n]+\|\n?)+/g, "").trim();
  }

  return { sections, rawText: text };
}

export function estimateTokens(section) {
  let text = section.heading || '';
  if (section.content) text += ' ' + section.content;
  for (const table of (section.tables || [])) {
    for (const h of (table.headers || [])) text += ' ' + h;
    for (const row of (table.rows || [])) {
      for (const v of Object.values(row)) text += ' ' + v;
    }
  }
  return Math.ceil(text.split(/\s+/).length * 1.3);
}
