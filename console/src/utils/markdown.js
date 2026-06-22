/**
 * Rich markdown-to-HTML renderer for AI chat responses.
 *
 * Faithful port of the legacy dashboard `md()` renderer so the React chat shows
 * the same professional formatting: markdown tables, status markers, headings,
 * nested lists, blockquotes, horizontal rules, links and fenced code blocks with
 * a copy button. Interactive @@TOKEN@@ cards are handled separately by
 * ChatTokens.jsx (parseSegments runs before this), so this only deals with plain
 * markdown segments.
 */

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Inline markdown: status markers, links, bold/italic, strikethrough, code spans.
function inlineMd(text) {
  // Status markers — colored, like the legacy renderer
  text = text.replace(/\[CRITICAL\]/g, '<span class="status-crit">[CRITICAL]</span>');
  text = text.replace(/\[WARNING\]/g, '<span class="status-warn">[WARNING]</span>');
  text = text.replace(/\[OK\]/g, '<span class="status-ok">[OK]</span>');
  text = text.replace(/\[INFO\]/g, '<span class="status-info">[INFO]</span>');
  // Links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Bold + italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, "<em>$1</em>");
  // Strikethrough
  text = text.replace(/~~(.+?)~~/g, "<del>$1</del>");
  return text;
}

// Parse nested unordered/ordered lists starting at lines[startI].
function parseList(lines, startI, type) {
  const items = [];
  let i = startI;
  let baseIndent = -1;
  const listPat = type === "ul" ? /^(\s*)[-*]\s(.*)/ : /^(\s*)\d+\.\s(.*)/;

  while (i < lines.length) {
    const m = lines[i].match(listPat);
    if (m) {
      const indent = m[1].length;
      if (baseIndent < 0) baseIndent = indent;
      if (indent > baseIndent) {
        const subStart = i;
        const subType = /^(\s*)[-*]\s/.test(lines[i]) ? "ul" : "ol";
        while (i < lines.length) {
          const nextM = lines[i].match(/^(\s*)[-*]\s|^(\s*)\d+\.\s/);
          if (nextM) {
            const ni = (nextM[1] || nextM[2] || "").length;
            if (ni <= baseIndent) break;
          } else if (/^\S/.test(lines[i])) break;
          else if (lines[i].trim() === "") break;
          i++;
        }
        if (items.length > 0) items[items.length - 1].sub = parseList(lines, subStart, subType);
        continue;
      } else if (indent < baseIndent) {
        break;
      }
      items.push({ text: m[2], sub: "" });
      i++;
    } else if (/^\s+\S/.test(lines[i]) && items.length > 0) {
      items[items.length - 1].text += " " + lines[i].trim();
      i++;
    } else {
      break;
    }
  }

  const tag = type === "ul" ? "ul" : "ol";
  return (
    "<" + tag + ' class="md-list">' +
    items.map((it) => "<li>" + inlineMd(it.text) + (it.sub || "") + "</li>").join("") +
    "</" + tag + ">"
  );
}

function flushPara(out) {
  if (out.length && out[out.length - 1].type === "para") {
    const item = out[out.length - 1];
    item.type = "block";
    item.html = "<p>" + item.lines.map((l) => inlineMd(l)).join("<br>") + "</p>";
    delete item.lines;
  }
}

export function renderMarkdown(text) {
  if (!text) return "";

  const placeholders = [];
  const ph = (html) => {
    const idx = placeholders.length;
    placeholders.push(html);
    return "\x00PH" + idx + "\x00";
  };

  // Strip HTML comments (e.g. <!--action:ID-->)
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Extract <details><summary> blocks BEFORE escaping → collapsible sections
  text = text.replace(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi, (m, summary, body) => {
    const trimBody = body.trim();
    return ph(
      '<details class="md-details"><summary class="md-details-summary">' +
      esc(summary) + '</summary><div class="md-details-body">' +
      esc(trimBody) + '</div></details>'
    );
  });

  // Extract fenced code blocks BEFORE escaping → styled box with copy button
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    const trimmed = code.replace(/^\n+|\n+$/g, "").replace(/@@SEC_FIX_CMD\|([^@]+)@@/g, "$1");
    const langLabel = lang ? lang.charAt(0).toUpperCase() + lang.slice(1) : "Code";
    const encoded = esc(trimmed).replace(/"/g, "&quot;");
    return ph(
      '<div class="md-codeblock">' +
        '<div class="md-codeblock-head"><span class="md-codeblock-lang">' + esc(langLabel) + "</span>" +
        '<button class="md-codeblock-copy" data-copy="' + encoded + '">Copy</button></div>' +
        "<pre><code>" + esc(trimmed) + "</code></pre>" +
      "</div>"
    );
  });

  // Extract inline code BEFORE escaping
  text = text.replace(/`([^`\n]+)`/g, (m, c) => ph('<code class="md-inline-code">' + esc(c) + "</code>"));

  // Escape remaining HTML
  text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Block-level parsing
  const lines = text.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Headings
    if (/^#{1,4} /.test(line)) {
      flushPara(out);
      if (/^#### /.test(line)) out.push({ type: "block", html: '<div class="chat-heading chat-heading-sm">' + inlineMd(line.replace(/^#### /, "")) + "</div>" });
      else if (/^### /.test(line)) out.push({ type: "block", html: '<div class="chat-heading">' + inlineMd(line.replace(/^### /, "")) + "</div>" });
      else if (/^## /.test(line)) out.push({ type: "block", html: '<div class="chat-heading h2">' + inlineMd(line.replace(/^## /, "")) + "</div>" });
      else out.push({ type: "block", html: '<div class="chat-heading h2">' + inlineMd(line.replace(/^# /, "")) + "</div>" });
      i++; continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      flushPara(out);
      out.push({ type: "block", html: "<hr>" });
      i++; continue;
    }

    // Block-level placeholder (code block on its own line)
    if (/^\x00PH\d+\x00$/.test(line.trim())) {
      flushPara(out);
      out.push({ type: "block", html: line.trim() });
      i++; continue;
    }

    // Markdown table
    if (/^\|.+\|/.test(line)) {
      flushPara(out);
      const tableLines = [];
      while (i < lines.length && /^\|.+\|/.test(lines[i])) { tableLines.push(lines[i]); i++; }
      if (tableLines.length >= 2) {
        const parseRow = (r) => r.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        const hdr = parseRow(tableLines[0]);
        const isSep = /^\|[\s:|-]+\|$/.test(tableLines[1].trim());
        const dataStart = isSep ? 2 : 1;
        let t = '<table class="md-table"><thead><tr>' + hdr.map((h) => "<th>" + inlineMd(h) + "</th>").join("") + "</tr></thead><tbody>";
        for (let ti = dataStart; ti < tableLines.length; ti++) {
          const cells = parseRow(tableLines[ti]);
          t += "<tr>" + cells.map((c) => "<td>" + inlineMd(c) + "</td>").join("") + "</tr>";
        }
        t += "</tbody></table>";
        out.push({ type: "block", html: t });
      }
      continue;
    }

    // Blockquote (> escaped to &gt;)
    if (/^&gt;\s?/.test(line)) {
      flushPara(out);
      const bqLines = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) { bqLines.push(lines[i].replace(/^&gt;\s?/, "")); i++; }
      out.push({ type: "block", html: "<blockquote>" + bqLines.map((l) => inlineMd(l)).join("<br>") + "</blockquote>" });
      continue;
    }

    // Unordered list
    if (/^(\s*)[-*]\s/.test(line)) {
      flushPara(out);
      out.push({ type: "block", html: parseList(lines, i, "ul") });
      while (i < lines.length && (/^(\s*)[-*]\s/.test(lines[i]) || (/^(\s+)\S/.test(lines[i]) && !/^(\s*)(\d+)\.\s/.test(lines[i]) && !/^(\s*)[-*]\s/.test(lines[i])))) i++;
      continue;
    }

    // Ordered list
    if (/^(\s*)\d+\.\s/.test(line)) {
      flushPara(out);
      out.push({ type: "block", html: parseList(lines, i, "ol") });
      while (i < lines.length && (/^(\s*)\d+\.\s/.test(lines[i]) || (/^(\s+)\S/.test(lines[i]) && !/^(\s*)[-*]\s/.test(lines[i]) && !/^(\s*)\d+\.\s/.test(lines[i])))) i++;
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      flushPara(out);
      i++; continue;
    }

    // Paragraph text
    if (!out.length || out[out.length - 1].type !== "para") out.push({ type: "para", lines: [] });
    out[out.length - 1].lines.push(line);
    i++;
  }
  flushPara(out);

  let html = out.map((item) => item.html).join("\n");
  html = html.replace(/\x00PH(\d+)\x00/g, (m, idx) => placeholders[parseInt(idx)]);
  return html;
}
