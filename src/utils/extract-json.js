/**
 * Robust extraction of a single JSON object from LLM output.
 *
 * Strips markdown code fences, then scans for the FIRST brace-balanced
 * object — ignoring braces inside strings — so trailing prose can't break
 * parsing. If the braces never balance, the response was truncated by the
 * token limit; callers surface that as an actionable error instead of a
 * generic parse failure.
 */
export function extractJsonObject(text) {
  let t = (text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = t.indexOf("{");
  if (start < 0) return { json: null, truncated: false };
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return { json: t.slice(start, i + 1), truncated: false }; }
  }
  return { json: null, truncated: true };
}
