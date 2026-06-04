function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderMarkdown(text) {
  if (!text) return "";

  const codeBlocks = [];
  let html = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="md-pre"><code class="md-code${lang ? ` lang-${esc(lang)}` : ""}">${esc(code.trimEnd())}</code></pre>`);
    return `\x00CB${idx}\x00`;
  });

  const inlineCode = [];
  html = html.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCode.length;
    inlineCode.push(`<code class="md-inline-code">${esc(code)}</code>`);
    return `\x00IC${idx}\x00`;
  });

  html = esc(html);

  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");
  html = html.replace(/_(.+?)_/g, "<em>$1</em>");

  html = html.replace(/^### (.+)$/gm, '<h4 class="md-h4">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 class="md-h3">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2 class="md-h2">$1</h2>');

  html = html.replace(/^[-*] (.+)$/gm, '<li class="md-li">$1</li>');
  html = html.replace(/((?:<li class="md-li">.*<\/li>\n?)+)/g, '<ul class="md-ul">$1</ul>');

  html = html.replace(/^\d+\. (.+)$/gm, '<li class="md-li">$1</li>');
  html = html.replace(/((?:<li class="md-li">.*<\/li>\n?){2,})/g, (match) => {
    if (!match.includes('<ul')) return `<ol class="md-ol">${match}</ol>`;
    return match;
  });

  html = html.replace(/\n{2,}/g, "</p><p>");
  html = `<p>${html}</p>`;
  html = html.replace(/<p><\/p>/g, "");

  codeBlocks.forEach((block, i) => {
    html = html.replace(`\x00CB${i}\x00`, block);
  });
  inlineCode.forEach((code, i) => {
    html = html.replace(`\x00IC${i}\x00`, code);
  });

  return html;
}
