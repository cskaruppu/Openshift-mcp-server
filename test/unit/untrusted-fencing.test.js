/**
 * fenceUntrusted(label, text) takes TWO arguments.
 *
 * Called with one, it does something quietly catastrophic rather than
 * throwing: the content becomes the LABEL, uppercased with every non-word
 * character replaced, and the fenced body is EMPTY. The model is then handed a
 * prompt with no subject in it and answers about nothing — while the call site
 * looks correct and the feature looks merely unhelpful.
 *
 * That is exactly what had happened to the VM provisioning extractor: the LLM
 * path had been receiving an empty fence since it was written, and the
 * heuristics were carrying the whole feature alone.
 *
 * So this is a lint, not a unit test. It reads the source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../src");

async function jsFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) out.push(...await jsFiles(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/**
 * Argument count for a call, by walking to the matching paren.
 *
 * Depth-aware and quote-aware, because the second argument is very often
 * `JSON.stringify(x)` or a template literal, and a naive split on "," would
 * count those as several arguments and pass a broken call.
 */
function argCount(src, openParen) {
  let depth = 0, commas = 0, i = openParen, quote = null, body = false;
  for (; i < src.length; i++) {
    const c = src[i], prev = src[i - 1];
    if (quote) {
      if (c === quote && prev !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; body = true; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; if (depth > 1) body = true; continue; }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return body || commas ? commas + 1 : 0;
      continue;
    }
    if (c === "," && depth === 1) { commas++; continue; }
    if (!/\s/.test(c)) body = true;
  }
  return -1; // unbalanced — the parser is wrong, not the source
}

test("every fenceUntrusted call passes a label AND the content", async () => {
  const offenders = [];
  for (const file of await jsFiles(ROOT)) {
    if (file.endsWith("untrusted.js")) continue;     // the definition itself
    const src = await readFile(file, "utf8");
    for (const m of src.matchAll(/fenceUntrusted\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const n = argCount(src, open);
      if (n === 1) {
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${file.replace(ROOT, "src")}:${line}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    "these calls fence an EMPTY body and put the content in the tag — pass fenceUntrusted(label, text)");
});

test("the argument counter is not fooled by commas inside the content", async () => {
  const { fenceUntrusted } = await import("../../src/services/untrusted.js");
  // Guard the guard: these shapes are what real call sites look like.
  assert.equal(argCount('fenceUntrusted("A", JSON.stringify({a: 1, b: 2}))', 14), 2);
  assert.equal(argCount("fenceUntrusted(`x, y`)", 14), 1);
  assert.equal(argCount('fenceUntrusted("LOGS", text)', 14), 2);

  // And the behaviour the lint exists to prevent, stated once.
  const wrong = fenceUntrusted("provision a VM in dev");
  assert.match(wrong, /START>>>\n\n<<</, "a one-argument call fences nothing at all");
  const right = fenceUntrusted("VM_REQUEST", "provision a VM in dev");
  assert.match(right, /provision a VM in dev/);
});
