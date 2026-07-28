# Use Case Documentation

Customer-facing use case collateral for the TCS Agentic AI platform.

## TCS Agentic AI — Zero-Touch Incident Command

**ZTIC** · Use Case 05

*Self-detecting · Self-documenting · Self-closing · Self-reverting incident lifecycle for OpenShift*

> **Nobody opens the ticket. Nobody writes the RCA. Nobody closes it.**
> The only decision a human makes is whether to apply the fix.

| Artifact | File | Contents |
|---|---|---|
| **Full details + flowcharts** | [`UC-05-Zero-Touch-Incident-Command.md`](./UC-05-Zero-Touch-Incident-Command.md) | Demo description, **8 Mermaid flowcharts, colour-coded by actor** (actor-coded master flow, effort split, noise-control funnel, dual detection triggers, state machine, duplicate handling, change ledger & revert, manual-vs-zero-touch) plus a step-by-step **actor matrix**, thresholds, guards, remediation catalogue, RCA deliverables, safety model, demo script, config |
| **Presentation** | `TCS_Agentic_AI_UC05_Zero_Touch_Incident_Command.pptx` | **17 slides** — title, problem, **who does what (AI / automatic / manual)**, actor-coded workflow, before/after, thresholds, noise control, **noise funnel (the numbers)**, **dedup — one fault one ticket**, AI RCA, RCA deliverables, remediation & safety, **change ledger & revert**, business value, demo script, config & status, closing |
| **Workbook** | `TCS_Agentic_AI_UC05_Zero_Touch_Incident_Command.xlsx` | **18 sheets** — overview, workflow, state machine, thresholds, noise control, remediation, AI RCA, RCA document, safety, business value, demo script, configuration, verification, implementation map, **deduplication**, **escalation**, **change ledger & revert**, **actor matrix** |

### Recording a demo

[`UC-05-RCA-Agent-Narration.md`](./UC-05-RCA-Agent-Narration.md) — portfolio positioning
(TCS Agentic AI for Hybrid Infrastructure → Container & Kubernetes → RCA Agent) in short and full
written form, plus a 3:45 narration script walking the actor-coded flow. Read this first, then:

[`DEMO-SCRIPT-5min.md`](./DEMO-SCRIPT-5min.md) — a teleprompter-ready 5-minute script with
SHOW/SAY columns, cumulative timings, the pre-recording staging that makes it fit, what to cut if
you run long, a 7-minute variant, and Clipchamp production settings.

### Regenerating

Both documents are generated from code so they stay in sync with the implementation:

```bash
node usecase/generate-uc05-ppt.cjs      # → .pptx
node usecase/generate-uc05-excel.cjs    # → .xlsx
```

Requires `pptxgenjs` and `exceljs` (already in `package.json`).

### Viewing the flowcharts

The Markdown uses Mermaid diagrams, which render natively on GitHub. For a local
preview, use any Mermaid-capable viewer (VS Code Markdown Preview Mermaid Support,
or mermaid.live).

---

## Use case index

| ID | Name | Trigger | Collateral |
|---|---|---|---|
| UC-01 | Intelligent Pod Troubleshooting | Human asks in chat | `generate-master-ppt.cjs` |
| UC-02 | Autonomous Cluster Upgrade | Human requests upgrade | `docs/` |
| UC-03 | Predictive Intelligence & Anomaly Detection | Scheduled analysis | `generate-uc03-excel.cjs` |
| UC-04 | Security & Compliance Governance | Continuous scanning | `generate-uc04-excel.cjs` |
| **UC-05** | **TCS Agentic AI — Zero-Touch Incident Command (ZTIC)** | **None — fully autonomous** | **this folder** |

UC-05 is the only use case with **no human trigger**, the only one that **closes its own
tickets** with an audit-grade RCA, and the only one that keeps a **change ledger with
one-click revert**.
