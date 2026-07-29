# TCS Agentic AI — RCA Agent (UC-05)
## Complete demo script · 5 minutes

**TCS Agentic AI for Hybrid Infrastructure → Container & Kubernetes Operations → RCA Agent (UC-05)**

This is the single script for the recorded demo. It combines the positioning and flow narration with
the live product walkthrough, cut to a hard five minutes.

| | |
|---|---|
| **Runtime** | **4 minutes 59 seconds** — 672 spoken words at a measured 135 wpm |
| **Structure** | Part 1 · positioning and flow (2:31) → Part 2 · live incident (2:28) |
| **Read** | the **SAY** column aloud · the **SHOW** column is what is on screen |
| **Supersedes** | `UC-05-RCA-Agent-Narration.md` and `UC-05-DEMO-WALKTHROUGH.md`, both retained as source material |

> Timings are cumulative and assume an unhurried 135 words per minute. Aim slightly **under** each
> marker — adding a pause in editing is easy, cutting words out of a recording is not.

---

## Before you record

The detection loop runs **every two minutes**. You cannot break something on camera and wait for it,
so the incident must already be waiting when you start.

| # | Do this | Why |
|---|---|---|
| 1 | Break a workload **5–10 minutes early** — set a deployment's memory limit far too low so it OOMKills | The incident is then already in the Approval Inbox when you start recording |
| 2 | **Do not click Approve** | That click is the centrepiece of Part 2 |
| 3 | Open **Auto-Detect** once so the data is warm | Avoids a loading spinner on camera |
| 4 | Export the actor-coded flowchart as a **still image** (slide 3 of the deck) | Rendering Mermaid live on camera is an unnecessary risk |
| 5 | Open **ServiceNow in a second tab**, on the incident record | You switch to it twice, at 3:50 and 4:32 |
| 6 | Browser zoom **110–125 %** | Text must survive video compression |
| 7 | Close Slack, Teams and notifications | — |

**Check the incident record reads professionally before you record it.** The ticket is on screen for
sixteen seconds and the audience will read it. Confirm it shows: a short description naming the
workload and namespace, priority derived from impact × urgency, the correct assignment group, and a
description containing the exit code and the terminated container's log excerpt. If any of those are
blank or placeholder, fix the source data before recording — not in post.

**Record in two takes:** Take 1 is 0:00 → 2:31 (slides). Take 2 is 2:31 → 4:59 (the live incident).
Join them in Clipchamp with a hard cut — no transition effect.

---

# Part 1 · Positioning and flow

### 0:00 – 0:18 · The portfolio

**SHOW:** Title slide — *TCS Agentic AI for Hybrid Infrastructure*.

> **SAY:**
> "TCS Agentic AI for Hybrid Infrastructure is a comprehensive agentic solution across
> infrastructure services — compute, platform, storage, network and service management.
>
> Within that portfolio, the use case built for containers and Kubernetes is the RCA Agent.
> Use case zero five."

---

### 0:18 – 0:41 · What it replaces

**SHOW:** The manual-versus-zero-touch comparison, or a plain problem slide.

> **SAY:**
> "Today, when a workload fails, an engineer notices it, opens a ticket, investigates, writes the
> root cause by hand, applies a fix, then goes back and closes the ticket.
>
> Six touchpoints, and most of them are administration.
>
> The RCA Agent removes all of them except the decision to apply the fix."

---

### 0:41 – 2:00 · The flow

**SHOW:** The actor-coded UC-05 flowchart, full screen. Move a pointer across the three phases as you
describe them.

> **SAY:**
> "This is the end-to-end flow, and the colours matter.
>
> Blue is deterministic automation — no AI, no human. Purple is the single step where AI is applied.
> Amber is the only point where a person is required.
>
> On the left, the agent scans every two minutes against industry-standard thresholds — the same
> rules that ship with OpenShift. A breach only counts once sustained, so transient conditions never
> raise anything. Related signals are then merged: a workload that is out of memory, crash-looping
> and short of replicas is one incident, not three tickets.
>
> In the middle, the agent gathers real evidence — container logs, events, resource limits and exit
> codes — and the AI determines the root cause.
>
> It then classifies the incident against the ITIL priority matrix, routes it to the correct queue,
> selects a remediation, and dry-runs it against the cluster.
>
> And then it stops. Here, at the approval gate.
>
> On approval, the right-hand side runs unattended: apply, verify recovery, attach the analysis,
> close the incident, and record the change with its inverse so it can be reverted."

⏸ **Pause one full second** after *"here, at the approval gate."* Let the audience look at the amber box.

---

### 2:00 – 2:31 · The differentiator

**SHOW:** Hold on the flowchart, or cut to the effort-split diagram.

> **SAY:**
> "Two things worth emphasising.
>
> The remediation command is chosen by a deterministic rule set, not by the AI. The AI explains;
> fixed logic acts. So the AI can be wrong about why something failed without ever being able to run
> the wrong command.
>
> And there is no human trigger anywhere in this. Twenty automated steps, one AI step, one human
> decision.
>
> Let me show you a live example."

---

# Part 2 · The live incident

### 2:31 – 2:38 · The console

**SHOW:** Cut to the console, on AI Intelligence.

> **SAY:**
> "This is the console. Everything from here on is live — one real incident, start to finish."

---

### 2:38 – 3:15 · Autonomous detection

**SHOW:** The Auto-Detect view. Point at the detection counters **before** you speak the numbers, then
open an actionable card. **Do not click Dry-run or Apply Fix here** — name them, leave them.

> **SAY:**
> "Everything on this screen was found by the agent. Nobody reported it, and nobody asked it to look.
>
> The numbers matter. Twenty-six raw symptoms, correlated down to twenty-four detections — and
> exactly one that met the bar for a ticket. The other twenty-three are long-standing conditions it
> deliberately will not page anyone about.
>
> Each actionable detection arrives with a remediation already prepared: a dry-run that validates the
> fix against the live cluster without changing anything, and Apply Fix, which carries it out."

---

### 3:15 – 3:50 · The root-cause analysis

**SHOW:** Click **View RCA**. Scroll at reading speed — the audience needs to see this is a real
document, not a summary.

> **SAY:**
> "View RCA opens the full analysis.
>
> It records the timeline stage by stage — when the condition began, when it was detected, when the
> ticket was raised, when the fix was applied and when it resolved — with elapsed time at each step.
>
> Below that: the root cause, the supporting evidence including the actual container log lines, the
> verification result, and the preventive actions.
>
> This is generated for every incident, to the same standard, regardless of who is on call."

---

### 3:50 – 4:07 · The incident in the ITSM tool

**SHOW:** Switch to ServiceNow, on the incident record. This is the ticket **open**.

> **SAY:**
> "The incident itself was raised automatically.
>
> Here it is in the ITSM tool, with the priority derived from the impact and urgency matrix, routed
> to the right assignment group, and fully described.
>
> No one opened this ticket."

---

### 4:07 – 4:32 · Approve, apply, verify

**SHOW:** Back to the console. Click **▷ Dry-run**, show the output, then **✅ Apply Fix**. Let the
terminal output and the before/after container table render fully.

> **SAY:**
> "I approve the fix. That is the only manual step in the entire lifecycle.
>
> The agent applies it, then verifies that the workload actually recovered — you can see the
> container status before and after, and the command output as it ran.
>
> Verification comes first. Only once the workload is confirmed healthy does the agent proceed."

⏸ **Pause one full second** after *"the only manual step in the entire lifecycle."*

---

### 4:32 – 4:59 · Attach, close, and the safety net

**SHOW:** ServiceNow again — the same ticket, now **closed**, with the RCA in the close notes and the
HTML and PDF attachments visible.

> **SAY:**
> "With recovery confirmed, the agent attaches the complete root-cause analysis, closes the incident,
> and records the change so it can be reverted.
>
> Resolved and closed automatically, with the full analysis attached for audit.
>
> And if verification had failed, it would not have closed anything. It escalates and leaves the
> ticket open. The agent will not report a success it cannot evidence."

---

## Cheat card

Keep this visible while narrating.

| Time | Beat | The one line to land |
|---|---|---|
| 0:00 | Portfolio | *"The use case built for containers and Kubernetes is the RCA Agent."* |
| 0:18 | The problem | *"Six touchpoints, and most of them are administration."* |
| 0:41 | The flow | *"And then it stops. Here, at the approval gate."* |
| 2:00 | Differentiator | *"Twenty automated steps, one AI step, one human decision."* |
| 2:31 | Console | *"Everything from here on is live."* |
| 2:38 | Detection | *"Twenty-four found, one ticketed. Restraint is the point."* |
| 3:15 | View RCA | *"Same standard every time, regardless of who is on call."* |
| 3:50 | ITSM | *"No one opened this ticket."* |
| 4:07 | Approve | *"The only manual step in the entire lifecycle."* |
| 4:32 | Close | *"It will not report a success it cannot evidence."* |

## Delivery notes

| | |
|---|---|
| **Register** | Measured and factual throughout. Part 1 is positioning, not a pitch — let the flow diagram carry the weight. |
| **Pace** | Slowest on the flow (0:41) and the RCA (3:15). Those two carry the substance. The portfolio and ITSM beats can move briskly. |
| **Pauses** | Two, both marked ⏸ — after *"the approval gate"* and after *"the only manual step."* |
| **Pointer** | At 2:38, physically point at the counters before you speak the numbers. |
| **Scrolling** | At 3:15, scroll at reading speed, not browsing speed. |
| **Naming** | Say *"RCA Agent"* throughout. Say *"use case zero five"* once, at 0:18, then drop it. |
| **Emphasis** | Stress **"deterministic rule set, not by the AI"** — it pre-empts the first question an architect asks. |
| **Do not say** | *"A lot of alerts"* · *"it fixes everything automatically"* · *"AI decides the fix"* — the last is factually wrong. |
| **If asked "what if the AI is wrong?"** | *"The AI writes the explanation. The command comes from a fixed rule set. So it can be wrong about why, without ever being able to run the wrong thing."* |

## If you run long — cut in this order

| Cut | Saves | Effect |
|---|---|---|
| 1. The 0:18 problem section | ~22s | Straight from portfolio to flow. Safe with an audience that already knows what incident toil costs. |
| 2. *"Related signals are then merged…"* at 0:40 | ~10s | Loses the deduplication point. |
| 3. Beat 4 down to *"No one opened this ticket."* | ~11s | Loses the ITIL routing detail — but the ticket is on screen anyway. |

**Do not cut:** the three colours on the flowchart, the *"AI explains, code acts"* line, the
dry-run-then-approve sequence, or the closing safety-net sentence. Those four are what make the demo
credible.

## If you have 7 minutes

Add, in this order: **Automation Settings** (~30s — every threshold and the ServiceNow queue are
configurable in the UI with no redeploy) · **a self-healed incident** (~30s — one that closed itself
with no fix applied) · **the escalation block** (~30s — a repeat offender that raised its own severity)
· **History and revert** (~25s — the before/after diff and the one-click Revert button).

## Clipchamp production notes

| Step | Setting |
|---|---|
| Capture | Screen **+** microphone, 1080p, 30 fps |
| Takes | Two, joined with a hard cut at 2:31 |
| Trim | Cut every pause longer than ~1 second except the two marked ⏸ — dead air reads as hesitation |
| Text overlays | Three, during the 0:41 flow section: **"20 automatic"**, **"1 AI"**, **"1 human decision"** |
| Zoom | Zoom in on the root-cause paragraph (3:23) and the before/after container table (4:18) |
| Music | Low volume or none. Narration must stay dominant |
| Captions | Auto-generate then proofread — "OOMKilled", "ServiceNow" and "ITIL" will be mis-transcribed |
| Export | 1080p MP4 |
| Fluffed line | Pause two seconds and repeat the whole sentence. That silence is an easy cut point |

---

# Appendix A · Written positioning

Not spoken. For decks, proposals, one-pagers and the video description.

### Short form — 45 words

> **TCS Agentic AI for Hybrid Infrastructure** is a comprehensive agentic solution across
> infrastructure services. **RCA Agent (UC-05)** is the capability built for container and Kubernetes
> estates: it detects incidents autonomously, determines root cause, remediates on a single approval,
> and closes the ticket with an audit-grade RCA.

### Full form — 130 words

> **TCS Agentic AI for Hybrid Infrastructure** is a comprehensive agentic solution spanning the
> infrastructure services landscape — compute, platform, storage, network and the service management
> layer that surrounds them.
>
> Within that portfolio, **RCA Agent (UC-05)** addresses the container and Kubernetes domain.
>
> It removes the administrative burden that dominates incident management today. The agent
> continuously evaluates the cluster against industry-standard thresholds, correlates related signals
> into a single incident, determines root cause from live evidence, raises a properly classified
> ServiceNow incident, and proposes a validated remediation.
>
> A person approves. Everything else — applying the fix, verifying recovery, attaching the root-cause
> analysis, closing the ticket and recording a reversible change history — is performed by the agent.
>
> **One human decision. Full audit trail. Every change reversible.**

### The one-line claim

> **RCA Agent detects the incident, explains it, fixes it and closes the ticket. A person approves
> the fix — that is the only manual step.**

### A note on the name

`RCA Agent` is what customers ask for by name, so it is the right label for conversation. Be aware
that root-cause analysis is **one of twenty-two steps** the agent performs. Where a title needs to
convey full scope, pair it with:

> **RCA Agent (UC-05)** — *autonomous detection, root cause, remediation and closure for Kubernetes*

---

# Appendix B · Why the beats are in this order

Part 2 follows the product's real sequence, which differs from the obvious one in three places.

| Beat | Note |
|---|---|
| **2 · Detection** | Names the dry-run and Apply Fix buttons but does not use them. Demonstrating the fix here and again at 4:07 spends it twice; the click is the centrepiece and should not be spoiled. |
| **3 · View RCA** | Deliberately **before** the fix. The RCA is generated at detection time, so it is already complete — and it explains why the remediation about to be applied is the correct one. |
| **5 · Verify** | Verification belongs **here**, not after closure. The product does **apply → verify → attach → close**. Showing recovery at 4:07 is what makes the closure at 4:32 credible. |
| **6 · Close** | Carries the audit close-out *and* the failure path. If verification fails the agent escalates and leaves the ticket open — which is the answer to *"what if the fix doesn't work?"*, given before anyone asks it. |

**On switching to ServiceNow twice** (3:50 and 4:32) — this is deliberate, not redundancy. You are
showing the **same ticket open, then closed**. That contrast is the proof. Do not collapse it into a
single visit.

**On the detection numbers** — never say *"a lot of alerts."* It invites the objection every
operations buyer is trained to make: *"so it's noisy."* Twenty-four found, one ticketed is the
opposite claim, and it is the stronger one. Automation that cries wolf gets switched off within a
week, and the audience knows it.
