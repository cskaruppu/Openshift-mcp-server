# TCS Agentic AI — 5-Minute Demo Recording Script

**For Clipchamp · teleprompter-ready · ~700 spoken words at a natural 140 wpm**

> Read the **SAY** column aloud. The **SHOW** column is what should be on screen at that moment.
> Timings are cumulative. Aim slightly under each marker — it is far easier to add a pause in
> editing than to cut words out of a recording.

---

## ⚠️ Read this first — the staging that makes 5 minutes possible

The detection loop runs **every 2 minutes**. You cannot break something on camera and wait for it.
Record in **two takes** and join them in Clipchamp.

**Before you hit record:**

| # | Do this | Why |
|---|---|---|
| 1 | Break a workload **5–10 minutes early** — e.g. set a deployment's memory limit far too low so it OOMKills | The incident is then already sitting in the Approval Inbox when you start |
| 2 | **Do not click Approve yet** | That click is your money shot in Take 2 |
| 3 | Open the **Auto-Detect** tab once, so data is warm | Avoids a loading spinner on camera |
| 4 | Have the **actor-coded flowchart** open as a still image (export slide 3 from the deck) | Mermaid rendering live on camera is a risk |
| 5 | Have **ServiceNow** open in a second tab, on the incident | You will switch to it at 4:10 |
| 6 | Set browser zoom to **110–125%** | Text must be readable in a compressed recording |
| 7 | Close Slack, Teams, notifications | Nothing worse than a popup mid-take |

**Take 1** = 0:00 → 3:05 (intro, tabs, flowchart).
**Take 2** = 3:05 → 5:00 (the live incident, already waiting).
Join them in Clipchamp with a simple cut — no fancy transition.

---

## The script

### 0:00 – 0:35 · Hook and what this is

**SHOW:** Login screen, then the workspace / cluster picker.

> **SAY:**
> "This is TCS Agentic AI for OpenShift.
> It is an autonomous operations platform. It watches your clusters, works out what is wrong,
> and fixes it — with one human approval.
> Today most incident work is not engineering. It is administration. Someone notices a problem,
> opens a ticket, writes the root cause by hand, applies a fix, then goes back and closes the ticket.
> We remove every one of those steps except the decision to apply the fix.
> Let me show you."

---

### 0:35 – 1:10 · Workspace and cluster selection

**SHOW:** The cluster picker. Hover a card. Open a kebab menu. Then select a cluster.

> **SAY:**
> "Everything starts here, in the workspace.
> Each card is a cluster we manage. The platform detects the platform type automatically —
> OpenShift, or plain Kubernetes — and shows live health, version and node count on the card.
> You can manage a cluster straight from the card menu, including redeploying the agent.
> Every query, every action and every chat session is scoped to whichever cluster you pick,
> so there is no chance of acting on the wrong one.
> I will select our lab cluster."

---

### 1:10 – 2:20 · The four tabs

**SHOW:** Click each tab as you name it. Scroll briefly. Do not stop to explain individual widgets.

> **SAY:**
> "There are four sections.
>
> **Dashboard** is the single pane. Cluster health, nodes, pods, namespaces and operators at the top.
> Then what needs attention — active alerts and pods at risk. Below that, governance scores,
> image vulnerabilities, capacity and utilisation, topology, and GPU fleet health if you run
> accelerated workloads.
>
> **AI Chat** is the conversational surface. You can ask in plain English why a pod is failing.
> It runs a real diagnosis on the live cluster, proposes a fix as a card you can dry-run and apply,
> and raises the ServiceNow incident for you.
>
> **Audit** is the compliance trail. CIS benchmark scoring, every change request, and a full record
> of every command this platform has ever executed.
>
> And **AI Intelligence** — which is where the new capability lives, and what I want to show you properly."

---

### 2:20 – 3:05 · UC-05 in one breath, on the flowchart

**SHOW:** The actor-coded flowchart, full screen. Point at the three colours, then the amber gate.

> **SAY:**
> "This is Zero-Touch Incident Command.
> The important thing on this diagram is the colours.
>
> **Blue is deterministic automation.** No AI, no human. Twenty of the twenty-two steps.
> **Purple is the one AI step** — reading the evidence and writing the root cause.
> **Amber is the only place a person is required.**
>
> And note this: the fix command itself is chosen by a fixed rule table, not by the AI.
> The AI explains. Deterministic code acts. That means the AI can be wrong about *why*
> without ever being able to run the wrong command.
>
> Nobody opens the ticket. Nobody writes the root cause. Nobody closes it.
> Let me show you a real one."

---

### 3:05 – 4:10 · The live incident

**SHOW:** AI Intelligence → Autonomous → Live. Point at the funnel numbers, then open the incident card.

> **SAY:**
> "Nobody asked for this. The platform found it on its own.
>
> Look at these numbers first. Twenty-six raw symptoms, correlated down to twenty-four detections,
> and exactly **one** that was worth a ticket. Twenty-three are long-standing problems it deliberately
> refuses to page anyone about. That restraint is the product — automation that cries wolf gets
> switched off in a week.
>
> Here is the one that mattered. It raised the ServiceNow incident itself, with the ITIL priority
> and the right assignment group.
>
> This is the AI analysis. The container exceeded its memory limit and was killed — exit code 137.
> That is not a guess, it is reading the actual container logs, including the previous terminated
> instance, which is where the useful output always is.
>
> And the proposed fix: raise the limit. Not restart it — restarting an out-of-memory container
> just repeats the kill."

---

### 4:10 – 4:45 · Dry-run, approve, close

**SHOW:** Click **▷ Dry-run**, show the output. Then **✅ Apply Fix**. Let the terminal and before/after
table appear. Switch to the ServiceNow tab showing the closed incident with attachments.

> **SAY:**
> "First a dry-run, against the live API server. Nothing has changed yet.
>
> Now I approve. That is the only click a human makes in this entire lifecycle.
>
> It applies the fix, and shows you the actual terminal output and the container status before and
> after — evidence, not a claim that it worked.
>
> And over in ServiceNow, the incident is already closed. The full root-cause analysis is in the
> close notes, with the timeline, the evidence and the preventive actions — and the report attached
> as HTML and PDF for the auditors."

---

### 4:45 – 5:00 · Close

**SHOW:** Back to AI Intelligence → History, showing the before → after diff and the Revert button.

> **SAY:**
> "And every change is logged with its inverse, so it can be reverted in one click.
>
> Detection, root cause, ticketing, the fix, verification and closure — all automatic.
> One human decision. And even that is reversible."

---

## If you run long — cut these first

1. **The Audit tab sentence** (saves ~8s) — mention it exists, move on.
2. **The GPU / topology clause** in the Dashboard section (saves ~6s).
3. **The funnel explanation** down to just *"twenty-six symptoms, one ticket"* (saves ~15s).
4. **The History / revert close** (saves ~12s) — end on the closed ServiceNow ticket instead.

Do **not** cut: the three colours on the flowchart, the "AI explains, code acts" line, or the
dry-run-then-approve sequence. Those are the three things that make the demo credible.

## If you have 7 minutes instead

Add, in this order:
1. **Automation Settings** (~30s) — show that the autonomous switch, the ServiceNow queue and every
   threshold are configurable in the UI with no redeploy.
2. **A self-healed incident** (~30s) — one that closed itself with no fix applied.
3. **The escalation block** (~30s) — a repeat offender that raised its own severity.

## Clipchamp production notes

| Step | Setting |
|---|---|
| Capture | Screen **+** microphone, 1080p, 30fps |
| Takes | Two (see staging above), joined with a hard cut |
| Trim | Cut every pause longer than ~1 second — dead air reads as hesitation |
| Text overlays | Add three: **"20 automatic"**, **"1 AI"**, **"1 human decision"** during the 2:20 flowchart section |
| Zoom | Use Clipchamp's zoom-in on the AI analysis paragraph (3:40) and the before/after table (4:35) |
| Music | Low-volume, or none. Narration must stay dominant |
| Captions | Auto-generate then proofread — "OOMKilled", "ServiceNow", "ITIL" and "ZTIC" will be mis-transcribed |
| Export | 1080p MP4 |

## Speaking tips

- **Slow down on the flowchart.** It is the only conceptual part. Everything else is visual.
- **Pause for one full second** after "That is the only click a human makes." Let it land.
- Say **"Zero-Touch Incident Command"** in full the first time. Use *"Zero-Touch"* after that.
- If you fluff a line, pause two seconds and repeat the whole sentence — that silence is an easy
  cut point in Clipchamp.
