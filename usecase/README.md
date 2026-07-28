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

👉 **[`UC-05-RCA-Agent-Demo-Script.md`](./UC-05-RCA-Agent-Demo-Script.md) — use this one.**

The single, complete script. **4:59** measured (672 spoken words at 135 wpm), in two parts:

- **Part 1 · Positioning and flow (2:31)** — the portfolio, what the agent replaces, the actor-coded
  flow narrated colour by colour, and the differentiator
- **Part 2 · The live incident (2:28)** — console → autonomous detection → View RCA → the ServiceNow
  record open → approve/apply/verify → attach, close and the safety net

Plus pre-recording staging, a cheat card, delivery notes, cut-list for running long, a 7-minute
variant, Clipchamp settings, the written positioning statements (Appendix A) and the rationale for
the beat order (Appendix B).

<details>
<summary>Superseded source material — kept for reference</summary>

| File | What it was |
|---|---|
| [`UC-05-RCA-Agent-Narration.md`](./UC-05-RCA-Agent-Narration.md) | Positioning + 3:45 flow narration. Folded into Part 1 and Appendix A. |
| [`UC-05-DEMO-WALKTHROUGH.md`](./UC-05-DEMO-WALKTHROUGH.md) | 2:47 six-beat walkthrough narration. Folded into Part 2 and Appendix B. |
| [`DEMO-SCRIPT-5min.md`](./DEMO-SCRIPT-5min.md) | Earlier 5-minute script covering all four tabs before reaching UC-05. Use this if the audience has never seen the platform. |

</details>

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
