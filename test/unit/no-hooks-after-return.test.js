import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Catches the class of bug that produced a blank screen and "Minified React
 * error #310" on the first click into the migration agent: a React hook called
 * AFTER an early return.
 *
 *   function Panel({ data }) {
 *     useEffect(...)                       // hook 1
 *     if (!data) return <Spinner />        // ← early return
 *     const [x, setX] = useState()         // hook 2, only on some renders
 *   }
 *
 * The component runs one hook while the data is loading and two once it
 * arrives. React matches hooks by call order, so the counts disagree between
 * renders and it throws — taking the whole page down, not just the panel.
 *
 * Nothing else in this repo catches it. Node cannot: it is valid JavaScript.
 * The build cannot: it is valid JSX. The unit tests cannot: they exercise the
 * loaded state, which is the render where the hook count is already correct.
 * It only appears on the transition, in a browser, in production.
 *
 * `npm run lint` here is this style of static check rather than ESLint, so
 * react-hooks/rules-of-hooks never ran. This is that rule's most damaging case,
 * written for this codebase and needing no new dependency.
 *
 * DELIBERATELY CONSERVATIVE. It only looks at returns in the function's own
 * top-level statements — the early-return guard above — and ignores returns
 * nested inside blocks, callbacks or arrow functions. Fewer catches, and no
 * false positives to teach people to ignore it.
 */

const CONSOLE_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../console/src");

/** A React component or custom hook: the only places hooks may be called. */
const COMPONENT = /(?:^|\n)\s*(?:export\s+(?:default\s+)?)?function\s+([A-Z]\w*|use[A-Z]\w*)\s*\(/g;
const HOOK_CALL = /\b(use[A-Z]\w*)\s*\(/;

/** Every offence in one source file, by the same route the real scan takes. */
export function scan(src) {
  const out = [];
  for (const m of src.matchAll(COMPONENT)) {
    for (const hit of hooksAfterReturn(src, m.index + m[0].length)) {
      out.push({ component: m[1], ...hit });
    }
  }
  return out;
}

function jsxFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...jsxFiles(p));
    else if (/\.jsx?$/.test(entry)) out.push(p);
  }
  return out;
}

/**
 * Scan one component body for a hook that comes after a top-level return.
 *
 * Brace depth is counted from the function's opening brace, ignoring braces
 * inside strings, template literals and comments — a JSX file is full of
 * `{...}` that is not a block.
 */
export function hooksAfterReturn(src, afterName) {
  // Step over the PARAMETER LIST first. Components are written
  // `function Panel({ a, b })`, so the first "{" after the name opens the
  // destructuring pattern, not the body — starting there counts one brace,
  // closes it, and scans nothing. That mistake is why the first version of
  // this check passed against the file it was written for.
  let i = src.indexOf("(", afterName - 1);
  if (i < 0) return [];
  let parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")") { parens--; if (parens === 0) { i++; break; } }
  }
  const open = src.indexOf("{", i);
  if (open < 0) return [];

  let depth = 0, returnedAt = -1;
  i = open;
  const found = [];
  let line = src.slice(0, open).split("\n").length;

  while (i < src.length) {
    const c = src[i], two = src.slice(i, i + 2);

    if (c === "\n") { line++; i++; continue; }
    if (two === "//") { const nl = src.indexOf("\n", i); i = nl < 0 ? src.length : nl; continue; }
    if (two === "/*") { const end = src.indexOf("*/", i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      // Skip the literal whole, respecting escapes. Template substitutions can
      // nest, but their braces balance, so depth is unaffected by skipping.
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\n") line++;
        i += src[i] === "\\" ? 2 : 1;
      }
      i++;
      continue;
    }
    if (c === "{") { depth++; i++; continue; }
    if (c === "}") { depth--; i++; if (depth === 0) break; continue; }

    if (depth === 1) {
      const rest = src.slice(i, i + 400);
      if (returnedAt < 0 && /^return\b/.test(rest)) returnedAt = line;
      // Strictly AFTER the return line. `return useQuery({...})` is a hook in
      // the return expression, which always runs — flagging it would be a
      // false positive, and a check that cries wolf gets switched off.
      if (returnedAt > 0 && line > returnedAt) {
        const m = rest.match(HOOK_CALL);
        // Only a call that STARTS here, so `useState` inside a longer
        // identifier or a later position is not counted twice.
        if (m && m.index === 0) found.push({ hook: m[1], line, returnedAt });
      }
    }
    i++;
  }
  return found;
}

/**
 * Known, unfixed, and deliberately not hidden.
 *
 * ConnectClusterModal has the same defect this check was written for:
 * `if (!open) return null` at the top, another useCallback further down. It is
 * mounted permanently and toggled by its `open` prop, so the hook count changes
 * every time the modal opens — and there is a componentDidCatch named after
 * this very component a few lines above it, which reads like it has already
 * crashed once and been wrapped rather than fixed.
 *
 * ClusterPickerView.jsx is protected by CLAUDE.md, so this is recorded here
 * instead of being quietly repaired. Remove the entry when it is fixed; the
 * check will keep it honest.
 */
const KNOWN = new Set([
  "console/src/views/ClusterPickerView.jsx:604 — ConnectClusterModal() calls useCallback() after returning at line 581",
]);

test("no React hook is called after an early return", () => {
  const offences = [];
  for (const file of jsxFiles(CONSOLE_SRC)) {
    for (const hit of scan(readFileSync(file, "utf8"))) {
      const at = `${file.replace(CONSOLE_SRC, "console/src")}:${hit.line} — ${hit.component}() calls ${hit.hook}() after returning at line ${hit.returnedAt}`;
      if (!KNOWN.has(at)) offences.push(at);
    }
  }
  assert.deepEqual(offences, [],
    `A hook after an early return runs on some renders and not others. React matches hooks by call order, so this throws #310 and blanks the page:\n  ${offences.join("\n  ")}`);
});

test("the check actually detects the bug it was written for", () => {
  // The exact shape that shipped: a guard clause, then a hook.
  const bad = `
function CutoverPanel({ posture }) {
  const ref = useRef(null);
  if (!posture) return <div>loading</div>;
  const { state } = posture;
  const [pick, setPick] = useState("");
  return <div>{state}</div>;
}`;
  const hits = scan(bad);
  assert.equal(hits.length, 1, "the offending useState must be found");
  assert.equal(hits[0].hook, "useState");
  assert.equal(hits[0].component, "CutoverPanel");

  // And the corrected shape is clean.
  const good = `
function CutoverPanel({ posture }) {
  const ref = useRef(null);
  const [pick, setPick] = useState("");
  if (!posture) return <div>loading</div>;
  return <div>{pick}</div>;
}`;
  assert.deepEqual(scan(good), []);

  // A return inside a nested block or callback is not an early return of the
  // component, and must not be reported — a guard people ignore is worthless.
  const nested = `
function List({ items }) {
  const rows = items.map((i) => { return i.name; });
  const [x, setX] = useState(0);
  return <div>{rows}{x}</div>;
}`;
  assert.deepEqual(scan(nested), []);

  // A hook in the RETURN EXPRESSION always runs, so it is not an offence.
  // `export function useClusterQuery(...) { return useQuery({...}) }` is the
  // normal shape of a custom hook and must stay silent.
  const wrapped = `
export function useClusterQuery(path) {
  const cluster = useActiveCluster();
  return useQuery({ queryKey: [path, cluster] });
}`;
  assert.deepEqual(scan(wrapped), []);

  // Braces inside strings and JSX text must not confuse the depth count.
  const strings = `
function Panel({ a }) {
  const s = "a } brace in a string {";
  const t = \`and \${a} in a template }\`;
  const [x, setX] = useState(0);
  return <div>{s}{t}{x}</div>;
}`;
  assert.deepEqual(scan(strings), []);
});
