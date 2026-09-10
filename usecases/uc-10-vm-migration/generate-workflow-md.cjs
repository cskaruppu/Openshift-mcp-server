#!/usr/bin/env node
/**
 * Rewrites the workflow sections of use-case.md from workflow.cjs.
 *
 * The document, the deck and the workbook each used to carry their own copy of
 * the workflow, which is how they ended up four stages behind the product. All
 * three now read workflow.cjs; this script is what keeps the prose in step.
 *
 * It replaces only what sits between the markers, so everything a person wrote
 * around it survives.
 */
const fs = require("fs");
const path = require("path");
const WF = require("./workflow.cjs");

const ICON = { [WF.AU]: "🔵 Deterministic", [WF.AI]: "🟣 **AI**", [WF.MA]: "🟡 **Manual**", [WF.EX]: "🔗 External" };
const MD = path.join(__dirname, "use-case.md");
const START = "<!-- BEGIN GENERATED WORKFLOW -->";
const END = "<!-- END GENERATED WORKFLOW -->";

const rows = WF.STEPS.map(([id, stage, step, actor, what, where]) => {
  const st = WF.STAGES.find((x) => x.id === stage);
  const emph = actor === WF.AI || actor === WF.MA;
  const cell = (t) => (emph ? `**${t}**` : t);
  const loc = /^[A-Z]/.test(where) && !where.includes("(") ? where : `\`${where}\``;
  return `| ${id} | ${st.name}${st.route === "warm" ? " *(warm)*" : ""} | ${cell(step)} | ${ICON[actor]} | ${what} | ${loc} |`;
}).join("\n");

const stageRows = WF.STAGES.map((st) => {
  const steps = WF.STEPS.filter((x) => x[1] === st.id);
  const tally = {};
  for (const x of steps) tally[x[3]] = (tally[x[3]] || 0) + 1;
  const mix = [[WF.AU, "🔵"], [WF.MA, "🟡"], [WF.AI, "🟣"], [WF.EX, "🔗"]]
    .filter(([k]) => tally[k]).map(([k, i]) => `${i}${tally[k]}`).join(" ");
  return `| **${st.id}. ${st.name}**${st.route === "warm" ? " *(warm only)*" : ""} | ${steps.length} | ${mix} | ${st.blurb} |`;
}).join("\n");

const N = WF.counts();

const body = `${START}

### The nine stages

Warm and cold are genuinely different journeys, not one journey with a flag. A
**cold** migration powers the guest off at the *start* and the whole transfer is
the outage; a **warm** one keeps it serving users and spends the outage at the
very end, at the cutover. Drawn as one pipeline, a cold plan promises a cutover
step it will never have.

| Stage | Steps | Actors | What it is for |
|---|---|---|---|
${stageRows}

\`\`\`mermaid
flowchart LR
    subgraph BOTH[" "]
      direction LR
      S1["1 · DISCOVER<br>read-only inventory"]:::auto
      S2["2 · ANALYSE<br>matrix · checks · capacity"]:::auto
      S3["3 · SELECT<br>wave + warm or cold"]:::manual
      S4["4 · PLAN & CHANGE<br>estimate · window · CAB"]:::auto
      S1 --> S2 --> S3 --> S4
    end
    S4 --> COLD["5 · POWER OFF & COPY<br><b>the copy IS the outage</b>"]:::manual
    S4 --> WARM["5 · DISKS COPY<br>guest keeps serving users"]:::auto
    WARM --> CUT["6 · CUTOVER<br><b>the only downtime</b>"]:::manual
    COLD --> V["VERIFY<br>5 checks, incl. source is OFF"]:::auto
    CUT --> V
    V --> RET["RETIRE THE SOURCE<br>2nd change request, after a soak"]:::crit
    V -- "any check fails" --> RB["ROLL BACK<br>source VMs never deleted"]:::manual

    classDef auto fill:#dbeafe,stroke:#2563eb,stroke-width:1.5px,color:#1e40af
    classDef manual fill:#fef3c7,stroke:#d97706,stroke-width:2.5px,color:#92400e
    classDef crit fill:#fee2e2,stroke:#dc2626,stroke-width:2px,color:#991b1b
\`\`\`

### Every step, and who performs it

**${WF.ratioLine()}.** That ratio is the argument, not an apology: a model where
judgement is genuinely required, measurement everywhere a fact exists, and a
person on both irreversible acts — starting a migration, and deleting the source.

| # | Stage | Step | Actor | What happens | Where it lives |
|---|---|---|---|---|---|
${rows}

> **${N[WF.AI]} AI steps out of ${N.total}.** Both are advisory, both are clamped by
> rules before anyone sees the answer, and neither can start, stop or alter a
> migration. The supportability verdict, all 15 readiness checks, the capacity
> check, the transfer estimate and every verification check are computed.

${END}`;

const src = fs.readFileSync(MD, "utf8");
const i = src.indexOf(START), j = src.indexOf(END);
if (i < 0 || j < 0) {
  console.error(`Markers not found in ${MD}. Add ${START} / ${END} around the workflow sections.`);
  process.exit(1);
}
fs.writeFileSync(MD, src.slice(0, i) + body + src.slice(j + END.length));
console.log(`✅ use-case.md workflow regenerated — ${WF.ratioLine()}`);
