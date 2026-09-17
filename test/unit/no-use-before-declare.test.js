import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Catches the bug that put "Cannot access 'X' before initialization" on screen
 * and took the whole console down with it.
 *
 *   const [page, setPage] = useState(1);
 *   useEffect(() => { setPage(1); }, [view, filter]);   // ← filter not declared yet
 *   const [filter, setFilter] = useState("");
 *
 * A dependency array is evaluated on EVERY render, so this throws the instant
 * the component mounts. `const` and `let` are hoisted but not initialised —
 * reading one before its declaration is a TypeError, not undefined — and a
 * throw during render has no recovery path, so React unmounts the tree and the
 * error boundary replaces the entire page rather than one panel.
 *
 * The existing hooks check could not see this: the hook call order is perfectly
 * legal. What is illegal is the identifier it reads.
 *
 * DELIBERATELY NARROW. Only component-body declarations — two-space indent,
 * which is what every component in this codebase uses — and only usages at the
 * same level or deeper in the same function. Function declarations hoist and
 * are ignored; so are comments and string literals, which is where the first
 * version of this check produced three false positives.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../console/src");

function jsxFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...jsxFiles(p));
    else if (/\.jsx?$/.test(e)) out.push(p);
  }
  return out;
}

/** Strip comments and string/template literals — braces and names inside them are not code. */
function scrub(line) {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return "";
  return line
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''")
    .replace(/`[^`]*`/g, "``")
    .replace(/\/\/.*$/, "");
}

/** Top-level function bodies, so a name declared in one component is never
 *  compared against a usage in another — that mistake produced three false
 *  positives on the first run, and a check that cries wolf gets switched off. */
function componentRanges(lines) {
  const starts = [];
  lines.forEach((l, i) => {
    if (/^(?:export\s+)?(?:default\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(l)) starts.push(i);
  });
  return starts.map((s, k) => [s, (starts[k + 1] ?? lines.length) - 1]);
}

export function findUseBeforeDeclare(src) {
  const lines = src.split("\n");
  const hits = [];

  for (const [from, to] of componentRanges(lines)) {
    const decl = new Map();
    for (let i = from; i <= to; i++) {
      const m = lines[i].match(/^  const (?:\[\s*)?([A-Za-z_$][\w$]*)/);
      if (m && !decl.has(m[1])) decl.set(m[1], i + 1);
    }

    // ONLY DEPENDENCY ARRAYS. A reference inside a callback body is deferred —
    // it runs after the component has finished initialising, which is legal and
    // extremely common (`refreshStatus` called from a handler declared above
    // it). A dependency array is different: it is evaluated on every render, in
    // order, so a name that is not initialised yet throws there and only there.
    // Narrowing to this one position is what makes the check trustworthy enough
    // to leave switched on.
    for (let i = from; i <= to; i++) {
      const dep = scrub(lines[i]).match(/\}\s*,\s*\[([^\]]*)\]\s*\)/);
      if (!dep) continue;
      for (const raw of dep[1].split(",")) {
        const name = raw.trim().split(/[.?[]/)[0];
        if (!name) continue;
        const dline = decl.get(name);
        if (dline && dline > i + 1) {
          hits.push({ name, usedAt: i + 1, declaredAt: dline, line: lines[i].trim() });
        }
      }
    }
  }
  return hits;
}

test("no component reads a const before it is declared", () => {
  const offences = [];
  for (const file of jsxFiles(SRC)) {
    for (const h of findUseBeforeDeclare(readFileSync(file, "utf8"))) {
      offences.push(`${file.replace(SRC, "console/src")}:${h.usedAt} reads "${h.name}", declared at ${h.declaredAt}`);
    }
  }
  assert.deepEqual(offences, [],
    "A const is hoisted but not initialised, so reading it early throws during render — "
    + "and a throw during render replaces the whole page, not one panel:\n  " + offences.join("\n  "));
});

test("the check catches the shape that shipped", () => {
  const bad = `
function Panel() {
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [view, filter]);
  const [filter, setFilter] = useState("");
  return null;
}
`;
  const hits = findUseBeforeDeclare(bad);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "filter");
});

test("it does not fire on a deferred reference inside a callback", () => {
  // Legal and common: the handler runs long after the component has
  // initialised. Flagging this is what would get the check switched off.
  const ok = `
function Panel() {
  const onClick = () => { refresh([1]); };
  const url = "/api/things?filter=all";
  const refresh = useCallback(() => {}, []);
  const [filter, setFilter] = useState("");
  return filter;
}
`;
  assert.deepEqual(findUseBeforeDeclare(ok), [],
    "only a dependency array is evaluated eagerly enough to throw");
});

test("it scans the whole console and the real files are clean", () => {
  // Belt and braces: the narrowed rule must still find nothing in the tree.
  for (const file of jsxFiles(SRC)) {
    assert.deepEqual(findUseBeforeDeclare(readFileSync(file, "utf8")), [], file);
  }
});
