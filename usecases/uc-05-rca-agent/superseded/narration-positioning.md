# RCA Agent (UC-05) — Positioning & Narration

**TCS Agentic AI for Hybrid Infrastructure → Container & Kubernetes Operations → RCA Agent (UC-05)**

This document contains the written positioning statement (for decks, proposals and one-pagers) and
a timed narration script for the recorded walkthrough.

---

## 1. Written positioning

### 1.1 Short form — 45 words, for a slide or an email

> **TCS Agentic AI for Hybrid Infrastructure** is a comprehensive agentic solution across
> infrastructure services. **RCA Agent (UC-05)** is the capability built for container and
> Kubernetes estates: it detects incidents autonomously, determines root cause, remediates on a
> single approval, and closes the ticket with an audit-grade RCA.

### 1.2 Full form — 130 words, for a proposal or an opening slide

> **TCS Agentic AI for Hybrid Infrastructure** is a comprehensive agentic solution spanning the
> infrastructure services landscape — compute, platform, storage, network and the service
> management layer that surrounds them.
>
> Within that portfolio, **RCA Agent (UC-05)** addresses the container and Kubernetes domain.
>
> It removes the administrative burden that dominates incident management today. The agent
> continuously evaluates the cluster against industry-standard thresholds, correlates related
> signals into a single incident, determines root cause from live evidence, raises a properly
> classified ServiceNow incident, and proposes a validated remediation.
>
> A person approves. Everything else — applying the fix, verifying recovery, attaching the root-cause
> analysis, closing the ticket and recording a reversible change history — is performed by the agent.
>
> **One human decision. Full audit trail. Every change reversible.**

### 1.3 The one-line claim

> **RCA Agent detects the incident, explains it, fixes it and closes the ticket. A person approves
> the fix — that is the only manual step.**

### 1.4 A note on the name

`RCA Agent` describes the capability that customers ask for by name, so it is the right label for
conversation. It is worth being aware that root-cause analysis is **one of twenty-two steps** the
agent performs — detection, correlation, ticketing, remediation, verification, closure and the
change ledger are the others. If the deck ever needs to convey full scope in the title, the
descriptive line to pair with it is:

> **RCA Agent (UC-05)** — *autonomous detection, root cause, remediation and closure for Kubernetes*

---

## 2. Narration script — positioning and flow

**Runtime ≈ 3 minutes 45 seconds** (495 spoken words at a measured 135 wpm). This precedes the live product demo. Read the **SAY** column;
the **SHOW** column is what should be on screen.

### 0:00 – 0:32 · The portfolio

**SHOW:** Title slide — *TCS Agentic AI for Hybrid Infrastructure*.

> **SAY:**
> "TCS Agentic AI for Hybrid Infrastructure is a comprehensive agentic solution across the
> infrastructure services landscape.
> It spans compute, platform, storage, network, and the service management layer that surrounds them.
> Within that portfolio we have developed a set of use cases, each targeting a specific operational
> domain.
> The one I want to walk you through today addresses containers and Kubernetes.
> We call it the RCA Agent. Use case zero five."

---

### 0:32 – 1:15 · The problem it solves

**SHOW:** The "manual versus zero-touch" comparison, or a plain problem slide.

> **SAY:**
> "Consider what happens today when a workload fails in a Kubernetes estate.
> An engineer notices it. They open a ticket. They investigate. They write the root-cause analysis
> by hand. They apply a fix. Then they go back and close the ticket.
> Six touchpoints — and most of them are administration, not engineering.
> The closing step alone consumes hours of skilled time every week, and the quality of the root-cause
> record varies depending on who happened to be on call.
> The RCA Agent removes every one of those steps except one: the decision to apply the fix."

---

### 1:15 – 2:55 · The flow

**SHOW:** The actor-coded UC-05 flowchart, full screen. Move a pointer across the three phases as
you describe them.

> **SAY:**
> "This is the end-to-end flow. The colours matter, so let me start there.
>
> Blue is deterministic automation — no AI, no human. Purple is the single step where AI is applied.
> Amber is the only point at which a person is required.
>
> On the left, the agent scans the cluster every two minutes against industry-standard thresholds —
> the same rules that ship with OpenShift. A breach only counts once it has been sustained, so
> transient conditions and routine deployments never raise anything.
>
> Related signals are then merged. A workload that is out of memory, crash-looping and short of
> replicas is one incident, not three tickets.
>
> In the middle, the agent gathers real evidence — container logs, including the previous terminated
> instance, plus events, resource limits and exit codes. That evidence goes to the AI, which
> determines the root cause and writes the analysis.
>
> The agent then checks whether a ticket already exists for this condition before raising a new one,
> classifies it against the ITIL priority matrix, routes it to the correct queue, selects a
> remediation, and dry-runs that remediation against the live cluster.
>
> And then it stops — here, at the approval gate.
>
> On approval, the right-hand side runs unattended: apply, verify recovery, attach the root-cause
> analysis, close any duplicates, close the incident, and record the change with its inverse so it
> can be reverted."

---

### 2:55 – 3:45 · The differentiator

**SHOW:** Hold on the flowchart, or cut to the effort-split diagram.

> **SAY:**
> "Two points are worth emphasising.
>
> First, the remediation command is selected by a deterministic rule set, not by the AI.
> The AI explains. Fixed logic acts. That means the AI can be wrong about why something failed
> without ever being able to run the wrong command against your cluster.
>
> Second, this is not alerting and it is not a chatbot. There is no human trigger at any point.
> The agent closes its own tickets with an audit-grade root-cause analysis, and keeps a change
> ledger so every action it takes can be undone.
>
> Twenty automated steps. One AI step. One human decision.
> Let me show you a live example."

---

## 3. Delivery notes

| | |
|---|---|
| **Register** | Measured and factual. This section is positioning, not a product pitch — let the flow diagram carry the weight. |
| **Pace** | Slower than the demo section. This is the only conceptual part; everything after it is visual. |
| **Pause** | One full second after *"And then it stops — here, at the approval gate."* Let the audience look at the amber box. |
| **Emphasis** | Stress **"deterministic rule set, not by the AI"**. It pre-empts the first question an architect will ask. |
| **Naming** | Say *"RCA Agent"* throughout. Say *"use case zero five"* once, at the start, then drop it. |
| **Numbers** | *"Twenty automated steps, one AI step, one human decision"* is the line to land on. Say it slowly. |

## 4. Where this fits in the recording

```
[ 0:00 ]  Positioning and flow      ← this script                    3:45
[ 3:45 ]  Live product walkthrough  ← DEMO-SCRIPT-5min.md §3:05+     2:00
[ 5:45 ]  Close                                                      0:15
                                                              TOTAL ≈ 6:00
```

**To fit a hard five-minute limit**, take one of these:

| Option | Saves | Effect |
|---|---|---|
| Replace the 0:00–1:15 opening with §1.1 read aloud | ~1:05 | Loses the "six touchpoints" problem framing |
| Cut the 0:32–1:15 problem section entirely | ~0:43 | Goes straight from portfolio to flow — works if the audience already knows the pain |
| Trim the flow narration to the three colours plus the approval gate | ~0:50 | Keeps the shape, loses the detail |

The recommended cut is the **second** — an infrastructure audience already knows what incident
toil costs, and the flow diagram is what they came to see.
