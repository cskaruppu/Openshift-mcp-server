# Use Cases

Customer-facing collateral for the **TCS Agentic AI for Hybrid Infrastructure** platform.

One folder per use case. Each contains its own generators and the deliverables they produce, so a
document and the code that built it never drift apart.

## Index

| ID | Use case | Trigger | Folder |
|---|---|---|---|
| **UC-01** | Intelligent Pod Troubleshooting | Human asks in chat | [`uc-01-pod-troubleshooting/`](./uc-01-pod-troubleshooting/) |
| **UC-02** | Autonomous Cluster Upgrade | Human requests upgrade | [`uc-02-cluster-upgrade/`](./uc-02-cluster-upgrade/) |
| **UC-03** | Predictive Intelligence & Anomaly Detection | Scheduled analysis | [`uc-03-predictive-intelligence/`](./uc-03-predictive-intelligence/) |
| **UC-04** | Security & Compliance Governance | Continuous scanning | [`uc-04-security-compliance/`](./uc-04-security-compliance/) |
| **UC-05** | Zero-Touch Incident Command *(demo name: RCA Agent)* | **None — fully autonomous** | [`uc-05-rca-agent/`](./uc-05-rca-agent/) |

### Not yet assigned an ID

| Use case | Folder | Note |
|---|---|---|
| End-to-End Incident Response | [`incident-response/`](./incident-response/) | Its workbook calls itself *"Use Case 2"*, which collides with UC-02 above. Needs an ID. |
| Configuration Drift Detection & One-Click Rollback | [`drift-detection/`](./drift-detection/) | Complete deck and workbook, never added to the index. |

### Portfolio-level

[`portfolio/`](./portfolio/) — collateral spanning all use cases: ROI analysis, hackathon material,
and the automation-opportunities workbook.

---

## UC-05 — the flagship

*Self-detecting · self-documenting · self-closing · self-reverting incident lifecycle for OpenShift*

> **Nobody opens the ticket. Nobody writes the RCA. Nobody closes it.**
> The only decision a human makes is whether to apply the fix.

| Artifact | File |
|---|---|
| **Full specification + 8 actor-coded flowcharts** | [`use-case.md`](./uc-05-rca-agent/use-case.md) |
| **Presentation** — 17 slides | `TCS-Agentic-AI-UC05-Zero-Touch-Incident-Command.pptx` |
| **Workbook** — 18 sheets | `TCS-Agentic-AI-UC05-Zero-Touch-Incident-Command.xlsx` |
| **Formal use case specification** | `TCS-Agentic-AI-UC05-Use-Case-Specification.xlsx` |

> **Open naming decision.** The deck and workbook say *Zero-Touch Incident Command (ZTIC)*; the demo
> scripts say *RCA Agent*. Both are defensible — ZTIC describes the full scope, RCA Agent is what
> customers ask for by name. They should not both be in front of the same audience.

### Recording the demo

👉 **[`demo-script.md`](./uc-05-rca-agent/demo-script.md) — use this one.**

The single complete script, **4:59** measured (672 spoken words at 135 wpm):

- **Part 1 · Positioning and flow (2:31)** — the portfolio, what the agent replaces, the actor-coded
  flow narrated colour by colour, and the differentiator
- **Part 2 · The live incident (2:28)** — console → autonomous detection → View RCA → the ServiceNow
  record open → approve/apply/verify → attach, close and the safety net

| Supporting file | Purpose |
|---|---|
| [`narration-only.txt`](./uc-05-rca-agent/narration-only.txt) | Spoken text only, in ten cue-pointed blocks. Teleprompter, or paste into a text-to-speech tool. |
| [`recording-toolkit.md`](./uc-05-rca-agent/recording-toolkit.md) | Capture tools, broadcast-quality voice for free, and the audio-led editing method. |
| `superseded/` | The earlier scripts these were merged from. Kept for reference. |

---

## Regenerating deliverables

Every document is generated from committed code. Each generator writes beside itself, so it can be
run from anywhere.

```bash
node usecases/uc-01-pod-troubleshooting/generate-ppt.cjs
node usecases/uc-03-predictive-intelligence/generate-excel.cjs
node usecases/uc-04-security-compliance/generate-excel.cjs
node usecases/uc-05-rca-agent/generate-ppt.cjs
node usecases/uc-05-rca-agent/generate-excel.cjs

python3 usecases/uc-02-cluster-upgrade/generate-usecase-excel.py
python3 usecases/uc-02-cluster-upgrade/generate-workflow-excel.py
python3 usecases/incident-response/generate-excel.py
python3 usecases/portfolio/generate-automation-opportunities.py
python3 usecases/portfolio/generate-roi-analysis.py
```

Node generators need `pptxgenjs` and `exceljs` (already in `package.json`).
Python generators need `openpyxl`; the product documents in `docs/` also need `python-docx`.

## Conventions

- Folders and source files — `kebab-case`
- Customer deliverables — `TCS-Agentic-AI-UC0X-Descriptive-Name.ext`

## Viewing the flowcharts

The Markdown uses Mermaid, which renders natively on GitHub. Locally, use any Mermaid-capable viewer
(VS Code *Markdown Preview Mermaid Support*, or mermaid.live).
