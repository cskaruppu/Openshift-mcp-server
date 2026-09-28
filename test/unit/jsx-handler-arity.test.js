/**
 * A React handler passed bare receives the synthetic event as its first
 * argument.
 *
 * `onClick={discover}` where `discover(acceptCertificate = false)` calls
 * discover(event). The event then travelled where a boolean belonged, into a
 * request body, and JSON.stringify died on it:
 *
 *   Converting circular structure to JSON --> starting at object with
 *   constructor 'HTMLButtonElement' | property '__reactFiber$…' -> object with
 *   constructor 'Pg' --- property 'stateNode' closes the circle
 *
 * The message names neither the handler nor the request, and the failure is a
 * long way from the mistake. It is invisible to a build, invisible to a type
 * checker in a plain-JS codebase, and only appears when somebody clicks — so
 * it is guarded here, by reading the source.
 *
 * The rule: a handler passed bare to onClick/onChange/onSubmit must take no
 * arguments. If it takes any, wrap it — `onClick={() => discover()}`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../console/src");

async function jsxFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) out.push(...await jsxFiles(p));
    else if (/\.jsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Parameters of a function declared as `const NAME = (args) =>` or
 * `function NAME(args)`. Returns null when the name is not declared in this
 * file — a prop like onRestart, which this cannot see and does not judge.
 */
function declaredParams(src, name) {
  const all = allDeclarations(src, name);
  return all.length ? all[0] : null;
}

/**
 * Every declaration of this name in the file.
 *
 * A file can declare the same handler name in two components — SettingsPanel
 * has a testConnection(key) and a testConnection() — and reading cannot tell
 * which one a given JSX line is inside. So all of them are collected and the
 * SAFE reading wins: if any declaration takes nothing, the call site is not
 * flagged. A lint that cries wolf on a correct file gets deleted.
 */
function allDeclarations(src, name) {
  const out = [];
  const arrow = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>`, "g");
  for (const m of src.matchAll(arrow)) out.push(m[1].trim());
  const bare = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?([A-Za-z_$][\\w$]*)\\s*=>`, "g");
  for (const m of src.matchAll(bare)) out.push(m[1].trim());
  const fn = new RegExp(`\\bfunction\\s+${name}\\s*\\(([^)]*)\\)`, "g");
  for (const m of src.matchAll(fn)) out.push(m[1].trim());
  return out;
}

/**
 * A first parameter that IS the event. `onClick={submit}` where `submit(e)`
 * is correct and idiomatic — the handler wants what React hands it. What is
 * wrong is a first parameter that means something else, because then the
 * event silently becomes that thing.
 */
const EVENT_PARAM = /^(e|ev|evt|event|_e)\b/;

/** Strip comments, so a handler NAMED in a comment is not read as code. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

test("no React handler is passed bare unless its first argument IS the event", async () => {
  const offenders = [];
  for (const file of await jsxFiles(ROOT)) {
    const raw = await readFile(file, "utf8");
    const src = stripComments(raw);
    for (const m of src.matchAll(/\bon(?:Click|Change|Submit|Input|KeyDown|Blur|Focus)=\{([A-Za-z_$][\w$]*)\}/g)) {
      const name = m[1];
      const decls = allDeclarations(src, name);
      if (!decls.length) continue;                                   // a prop, or imported — not ours to judge
      if (decls.some((d) => d === "" || EVENT_PARAM.test(d))) continue; // safe under some reading
      const params = decls[0];
      const line = src.slice(0, m.index).split("\n").length;
      offenders.push(`${file.replace(ROOT, "console/src")}:${line} — onClick={${name}} but ${name}(${params})`);
    }
  }
  assert.deepEqual(offenders, [],
    "wrap these: a bare handler is called with the synthetic event as its first argument");
});

test("the arity reader understands the shapes this codebase actually uses", () => {
  const src = [
    "const a = async (x = false) => {};",
    "const b = () => {};",
    "function c(y) {}",
    "const d = async () => {};",
    "const e = (v) => v;",
  ].join("\n");
  assert.equal(declaredParams(src, "a"), "x = false");
  assert.equal(declaredParams(src, "b"), "");
  assert.equal(declaredParams(src, "c"), "y");
  assert.equal(declaredParams(src, "d"), "");
  assert.equal(declaredParams(src, "e"), "v");
  assert.equal(declaredParams(src, "missing"), null, "a prop is not judged");
  // Two components in one file may declare the same handler name; reading
  // cannot tell which is in scope, so the safe one wins.
  const twice = "const t = async (key) => {};\nconst t = async () => {};";
  assert.deepEqual(allDeclarations(twice, "t"), ["key", ""]);
});

test("a handler that wants the event is not flagged, and a comment is not code", () => {
  assert.ok(EVENT_PARAM.test("e"));
  assert.ok(EVENT_PARAM.test("event"));
  assert.ok(!EVENT_PARAM.test("acceptCertificate = false"));
  assert.ok(!EVENT_PARAM.test("override"));
  // The bug report in a comment above the fix must not read as the bug.
  assert.doesNotMatch(stripComments("/* onClick={discover} */"), /onClick=\{discover\}/);
});
