import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";

/**
 * Catches the class of bug that produced "getSpokeUrl is not defined" in
 * production: calling a function that is never imported and never declared.
 *
 * Node's module loader cannot catch it — a missing import only throws when
 * that code path runs, so a handler behind a UI button can ship broken and
 * stay broken until someone clicks it.
 *
 * Deliberately conservative: a name counts as defined if it is bound ANYWHERE
 * in the file (import, declaration, parameter, catch clause). We are not doing
 * scope-accurate resolution — we are asserting that every function called by
 * name exists somewhere, which is exactly the failure we hit and carries no
 * false positives from shadowing or block scope.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

const GLOBALS = new Set([
  // language
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Math", "JSON",
  "Date", "RegExp", "Error", "TypeError", "RangeError", "SyntaxError", "EvalError",
  "Promise", "Map", "Set", "WeakMap", "WeakSet", "Proxy", "Reflect", "Function",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
  "encodeURI", "decodeURI", "eval", "globalThis", "undefined", "NaN", "Infinity",
  "Intl", "AggregateError", "structuredClone",
  // timers / web-ish
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate",
  "clearImmediate", "queueMicrotask", "fetch", "Headers", "Request", "Response",
  "AbortController", "AbortSignal", "URL", "URLSearchParams", "TextEncoder",
  "TextDecoder", "Blob", "FormData", "ReadableStream", "WritableStream", "Event",
  "EventTarget", "MessageChannel", "performance", "atob", "btoa", "crypto",
  // node
  "process", "Buffer", "console", "require", "module", "exports", "__dirname",
  "__filename", "global",
]);

/** Every name bound anywhere in the file. */
function boundNames(ast) {
  const names = new Set();
  const fromPattern = (p) => {
    if (!p) return;
    switch (p.type) {
      case "Identifier": names.add(p.name); break;
      case "ObjectPattern": p.properties.forEach((pr) => fromPattern(pr.value || pr.argument)); break;
      case "ArrayPattern": p.elements.forEach(fromPattern); break;
      case "AssignmentPattern": fromPattern(p.left); break;
      case "RestElement": fromPattern(p.argument); break;
    }
  };
  const visit = (n) => {
    if (!n || typeof n.type !== "string") return;
    switch (n.type) {
      case "ImportDeclaration": n.specifiers.forEach((sp) => names.add(sp.local.name)); break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (n.id) names.add(n.id.name);
        n.params.forEach(fromPattern);
        break;
      case "ClassDeclaration":
      case "ClassExpression": if (n.id) names.add(n.id.name); break;
      case "VariableDeclarator": fromPattern(n.id); break;
      case "CatchClause": fromPattern(n.param); break;
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object" && typeof v.type === "string") visit(v);
    }
  };
  visit(ast);
  return names;
}

/** Bare identifiers used in call position: foo(...) but not obj.foo(...). */
function calledNames(ast) {
  const calls = new Map(); // name -> first line
  const visit = (n) => {
    if (!n || typeof n.type !== "string") return;
    if ((n.type === "CallExpression" || n.type === "NewExpression") &&
        n.callee && n.callee.type === "Identifier") {
      if (!calls.has(n.callee.name)) calls.set(n.callee.name, n.loc?.start?.line ?? 0);
    }
    for (const k of Object.keys(n)) {
      if (k === "loc" || k === "range") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object" && typeof v.type === "string") visit(v);
    }
  };
  visit(ast);
  return calls;
}

function jsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...jsFiles(p));
    else if (e.endsWith(".js")) out.push(p);
  }
  return out;
}

test("no source file calls a function it never imports or declares", () => {
  const offenders = [];
  for (const file of jsFiles(SRC)) {
    const code = readFileSync(file, "utf8");
    let ast;
    try {
      ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true });
    } catch (e) {
      offenders.push(`${file}: parse error — ${e.message}`);
      continue;
    }
    const bound = boundNames(ast);
    for (const [name, line] of calledNames(ast)) {
      if (bound.has(name) || GLOBALS.has(name)) continue;
      offenders.push(`${file.replace(SRC, "src")}:${line} — ${name}() is never imported or declared`);
    }
  }
  assert.deepEqual(offenders, [],
    `Undefined function call(s) — these throw ReferenceError only when the code path runs:\n  ${offenders.join("\n  ")}`);
});

/** Names a module exports, read statically — importing it would run it. */
function exportedNames(file) {
  let ast;
  try {
    ast = acorn.parse(readFileSync(file, "utf8"), { ecmaVersion: "latest", sourceType: "module", locations: true });
  } catch { return null; }
  const names = new Set();
  const fromPattern = (p) => {
    if (!p) return;
    if (p.type === "Identifier") names.add(p.name);
    else if (p.type === "ObjectPattern") p.properties.forEach((pr) => fromPattern(pr.value || pr.argument));
    else if (p.type === "ArrayPattern") p.elements.forEach(fromPattern);
    else if (p.type === "AssignmentPattern") fromPattern(p.left);
    else if (p.type === "RestElement") fromPattern(p.argument);
  };
  for (const n of ast.body) {
    if (n.type === "ExportNamedDeclaration") {
      if (n.declaration) {
        if (n.declaration.id) names.add(n.declaration.id.name);
        (n.declaration.declarations || []).forEach((d) => fromPattern(d.id));
      }
      // `export { a, b as c }` — and re-exports, which we cannot follow here.
      n.specifiers.forEach((sp) => names.add(sp.exported.name));
      if (n.source) names.add("*");                   // re-export: stop asserting
    } else if (n.type === "ExportAllDeclaration") {
      names.add("*");
    } else if (n.type === "ExportDefaultDeclaration") {
      names.add("default");
    }
  }
  return names;
}

test("every named import resolves to a real export", () => {
  const offenders = [];
  const cache = new Map();
  for (const file of jsFiles(SRC)) {
    let ast;
    try {
      ast = acorn.parse(readFileSync(file, "utf8"), { ecmaVersion: "latest", sourceType: "module", locations: true });
    } catch { continue; }
    for (const node of ast.body) {
      if (node.type !== "ImportDeclaration") continue;
      const spec = node.source.value;
      if (!spec.startsWith(".")) continue;            // only our own modules
      const target = resolve(dirname(file), spec);
      if (!cache.has(target)) {
        let names = null;
        try { statSync(target); names = exportedNames(target); } catch { /* unresolved */ }
        cache.set(target, names);
      }
      const names = cache.get(target);
      if (names === null || names === undefined) {
        offenders.push(`${file.replace(SRC, "src")}:${node.loc.start.line} — cannot resolve ${spec}`);
        continue;
      }
      if (names.has("*")) continue;                   // re-exports: not statically followable
      for (const sp of node.specifiers) {
        if (sp.type !== "ImportSpecifier") continue;
        if (!names.has(sp.imported.name)) {
          offenders.push(`${file.replace(SRC, "src")}:${node.loc.start.line} — ${spec} does not export ${sp.imported.name}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `Broken import(s):\n  ${offenders.join("\n  ")}`);
});
