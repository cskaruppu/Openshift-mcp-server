/**
 * TCS Agentic AI — UC-10: renders use-case.md as use-case.docx.
 *
 * Thin wrapper over the markdown→docx converter that already exists for the
 * sample requirement documents — one converter, so the two never drift in how
 * they render a heading or a table.
 *
 * Run: node usecases/uc-10-vm-migration/generate-docx.cjs
 */
const path = require("path");
const { spawnSync } = require("child_process");

const converter = path.join(__dirname, "..", "..", "docs", "sample-requirements", "generate-docx.cjs");
const source = path.join(__dirname, "use-case.md");
const r = spawnSync(process.execPath, [converter, source], { stdio: "inherit" });
process.exit(r.status ?? 1);
