import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";

/**
 * Catches "mig is not defined" — a dynamic import bound inside one handler and
 * used from another.
 *
 * no-undefined-calls.test.js cannot catch this, and says so: it counts a name
 * as defined if it is bound ANYWHERE in the file, deliberately, to avoid false
 * positives from shadowing. That is the right trade for its job, and it is
 * precisely the hole this bug fell through — `const mig = await import(...)`
 * sat inside one route, and a route three thousand lines later called
 * `mig.checkMtvReadiness()`. Every test passed. It threw the first time an
 * operator opened the screen.
 *
 * So this one does resolve scope, but only far enough to answer one question:
 * is this name visible here at all? A name is visible if ANY binding of it
 * encloses the use — a static import (module scope, so it covers everything),
 * an outer declaration, a parameter, or the dynamic import itself. Only a name
 * whose sole bindings are block-scoped dynamic imports, used where none of
 * them reaches, is reported. That is always a bug, and nothing else is.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

const isFnScope = (n) => /^(Program|FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type);
const isBlockScope = (n) => isFnScope(n) || /^(BlockStatement|CatchClause|SwitchStatement|ForStatement|ForInStatement|ForOfStatement)$/.test(n.type);

const namesOf = (id) => !id ? []
  : id.type === "Identifier" ? [id.name]
  : id.type === "ObjectPattern" ? id.properties.flatMap((pr) => namesOf(pr.value || pr.key || pr.argument))
  : id.type === "ArrayPattern" ? id.elements.flatMap((e) => namesOf(e))
  : id.type === "AssignmentPattern" ? namesOf(id.left)
  : id.type === "RestElement" ? namesOf(id.argument)
  : id.type === "Property" ? namesOf(id.value || id.key)
  : [];

/**
 * Every binding, with the range of the scope it is visible in — plus the names
 * bound by a dynamic import somewhere other than module scope.
 */
function collect(ast) {
  const bindings = [];
  const dynamic = new Set();
  const add = (name, scope) => { if (name && scope) bindings.push({ name, start: scope.start, end: scope.end }); };

  const walk = (node, stack) => {
    if (!node || typeof node.type !== "string") return;
    const next = isBlockScope(node) ? [...stack, node] : stack;
    const block = next[next.length - 1] || ast;
    const fn = [...next].reverse().find(isFnScope) || ast;

    if (node.type === "ImportDeclaration") {
      // Static imports live at module scope and therefore cover every use.
      for (const sp of node.specifiers || []) add(sp.local?.name, ast);
    } else if (node.type === "VariableDeclaration") {
      const scope = node.kind === "var" ? fn : block;
      for (const d of node.declarations || []) {
        const isDyn = d.init?.type === "AwaitExpression" && d.init.argument?.type === "ImportExpression";
        for (const n of namesOf(d.id)) {
          add(n, scope);
          if (isDyn && scope !== ast) dynamic.add(n);
        }
      }
    } else if (node.type === "FunctionDeclaration") {
      add(node.id?.name, fn);
    } else if (node.type === "ClassDeclaration") {
      add(node.id?.name, block);
    }

    if (/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)) {
      for (const pr of node.params || []) for (const n of namesOf(pr)) add(n, node);
      if (node.id?.name) add(node.id.name, node);
    }
    if (node.type === "CatchClause" && node.param) for (const n of namesOf(node.param)) add(n, node);

    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "range") continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach((c) => walk(c, next));
      else if (child && typeof child.type === "string") walk(child, next);
    }
  };
  walk(ast, []);
  return { bindings, dynamic };
}

/** Every place a bare identifier is READ — not a property name, not a declaration. */
function identifierUses(ast) {
  const uses = [];
  const walk = (node, parent) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "Identifier" && parent) {
      const isProperty = parent.type === "MemberExpression" && parent.property === node && !parent.computed;
      const isKey = parent.type === "Property" && parent.key === node && !parent.computed;
      const isDecl = parent.type === "VariableDeclarator" && parent.id === node;
      const isParam = /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(parent.type)
        && (parent.params || []).includes(node);
      const isFnName = /^(FunctionDeclaration|ClassDeclaration)$/.test(parent.type) && parent.id === node;
      const isImportLocal = /^Import(Default|Namespace)?Specifier$/.test(parent.type);
      if (!isProperty && !isKey && !isDecl && !isParam && !isFnName && !isImportLocal) {
        uses.push({ name: node.name, start: node.start, line: node.loc?.start.line });
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "range") continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach((c) => walk(c, node));
      else if (child && typeof child.type === "string") walk(child, node);
    }
  };
  walk(ast, null);
  return uses;
}

export function crossScopeImportUses(source) {
  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true, ranges: true });
  const { bindings, dynamic } = collect(ast);
  if (!dynamic.size) return [];

  const bad = [];
  for (const u of identifierUses(ast)) {
    if (!dynamic.has(u.name)) continue;
    const visible = bindings.some((b) => b.name === u.name && u.start >= b.start && u.start <= b.end);
    if (!visible) bad.push({ name: u.name, line: u.line, start: u.start });
  }
  return bad;
}

test("a dynamic import is never used outside the scope that declared it", () => {
  const offences = [];
  for (const file of jsFiles(SRC)) {
    let bad;
    try { bad = crossScopeImportUses(readFileSync(file, "utf8")); }
    catch { continue; }   // unparseable files are the other checker's problem
    for (const b of bad) {
      offences.push(`${file.replace(SRC, "src")}:${b.line} — "${b.name}" is only ever bound by a dynamic import in another scope. It is undefined here and will throw the first time this path runs.`);
    }
  }
  assert.deepEqual(offences, [], `\n${offences.join("\n")}\n`);
});

test("the checker catches the shape that shipped, and allows the shapes that are fine", () => {
  // The real bug: bound in one handler, called from another.
  const hits = crossScopeImportUses(`
    async function routeA() { const mig = await import("./m.js"); return mig.go(); }
    async function routeB() { return mig.checkMtvReadiness(); }
  `);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "mig");

  // A module-level dynamic import covers every use.
  assert.deepEqual(crossScopeImportUses(`
    const mig = await import("./m.js");
    async function routeB() { return mig.go(); }
  `), []);

  // Each scope importing its own — the correct fix, and not an offence.
  assert.deepEqual(crossScopeImportUses(`
    async function routeA() { const mig = await import("./m.js"); return mig.go(); }
    async function routeB() { const mig = await import("./m.js"); return mig.stop(); }
  `), []);

  // A STATIC import of the same name must not be flagged just because some
  // handler also imports it dynamically. This is what the first version of
  // this checker got wrong, on ocpFetch, eleven times.
  assert.deepEqual(crossScopeImportUses(`
    import { ocpFetch } from "./c.js";
    async function a() { const { ocpFetch } = await import("./c.js"); return ocpFetch(1); }
    async function b() { return ocpFetch(2); }
  `), []);

  // Destructured and reached across: still caught.
  assert.equal(crossScopeImportUses(`
    async function a() { const { go } = await import("./m.js"); return go(); }
    async function b() { return go(); }
  `).length, 1);
});
