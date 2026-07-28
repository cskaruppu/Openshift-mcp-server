# RCA Agent (UC-05) — Demo Walkthrough Narration

**For narrating over the recorded video.** Six beats, matching the structure you drafted, rewritten
for a customer-facing delivery.

**Runtime ≈ 2 minutes 47 seconds** of narration (375 spoken words at a measured 135 wpm), leaving
room to pause on each screen.

---

## Two refinements to your draft

Both of these currently understate what the product does. Worth correcting before you record.

### ① "We see a lot of alerts which are auto-created"

Saying *a lot of alerts* invites the objection every operations buyer has been trained to make —
*"so it's noisy."* The opposite is your strongest point.

> **Say instead:** the agent found **24 conditions** and raised **one** ticket. The other 23 are
> long-standing problems it deliberately refuses to page anyone about.

Restraint is the differentiator. Automation that cries wolf gets switched off within a week, and
your audience knows it.

### ② The order of "close" and "validate"

Your points 5 and 6 read as *close the incident → then validate*. The product does the reverse, and
the real order is materially stronger:

> **apply → verify the workload actually recovered → only then attach the RCA and close**

And the safety property that follows from it: **if verification fails, the agent escalates and
deliberately leaves the ticket open.** It will not report a success it cannot evidence. That single
sentence answers the "what if the fix doesn't work?" question before it is asked.

---

## The narration

### Beat 1 · The platform and the agent

**SHOW:** Platform landing view, then navigate into AI Intelligence.

> "What you are looking at is the TCS Agentic AI platform.
> I am going to walk you through the RCA Agent — our use case for container and Kubernetes estates —
> and show you how it works from detection through to a closed ticket."

---

### Beat 2 · Autonomous detection, and the fix that comes with it

**SHOW:** The Auto-Detect view. Point at the detection counters first, then open an actionable card.

> "Everything on this screen was found by the agent. Nobody reported it, and nobody asked it to look.
>
> The numbers matter here. Twenty-six raw symptoms, correlated down to twenty-four detections —
> and exactly one that met the bar for a ticket. The other twenty-three are long-standing conditions
> it deliberately will not page anyone about.
>
> Each actionable detection arrives with a remediation already prepared. There is a dry-run, which
> validates the fix against the live cluster without changing anything, and then Apply Fix, which
> carries it out."

---

### Beat 3 · The root-cause analysis

**SHOW:** Click **View RCA**. Scroll slowly through the report — timeline, root cause, evidence.

> "View RCA opens the full analysis.
>
> It records the timeline stage by stage — when the condition began, when it was detected, when the
> ticket was raised, when the fix was applied and when it was resolved — with the elapsed time at
> each step.
>
> Below that is the root cause itself, the supporting evidence including the actual container log
> lines, the verification result, and the preventive actions to stop it recurring.
>
> This is generated for every incident, to the same standard, regardless of who is on call."

---

### Beat 4 · The incident in the ITSM tool

**SHOW:** Switch to ServiceNow, on the incident record.

> "The incident itself was raised automatically.
>
> Here it is in the ITSM tool, with the correct priority derived from the impact and urgency matrix,
> routed to the right assignment group, and fully described.
>
> No one opened this ticket."

---

### Beat 5 · Approve, apply, verify

**SHOW:** Back in the console. Click **Dry-run**, show the output, then **Apply Fix**. Let the
terminal output and the before/after container table appear.

> "I approve the fix. That is the only manual step in the entire lifecycle.
>
> The agent applies it, and then verifies that the workload actually recovered — you can see the
> container status before and after, and the command output as it ran.
>
> Verification comes first. Only once the workload is confirmed healthy does the agent proceed."

---

### Beat 6 · Attach, close, and the safety net

**SHOW:** ServiceNow again — the closed incident with the RCA in the close notes and the attachments.

> "With recovery confirmed, the agent attaches the complete root-cause analysis, closes the incident,
> and records the change so it can be reverted later if needed.
>
> The incident is resolved and closed automatically, with the full analysis attached for audit.
>
> And if verification had failed, it would not have closed anything. It escalates and deliberately
> leaves the ticket open — the agent will not report a success it cannot evidence."

---

## Cheat card

Keep this visible while narrating.

| # | Beat | The one line to land |
|---|---|---|
| 1 | Platform &amp; agent | *"RCA Agent — our use case for containers and Kubernetes."* |
| 2 | Detection | *"Twenty-four found, one ticketed. Restraint is the point."* |
| 3 | View RCA | *"Same standard every time, regardless of who is on call."* |
| 4 | ITSM | *"No one opened this ticket."* |
| 5 | Approve | *"The only manual step in the entire lifecycle."* |
| 6 | Close | *"It will not report a success it cannot evidence."* |

## Delivery notes

| | |
|---|---|
| **Pace** | Slow on beats 2 and 3 — those carry the substance. Beats 1 and 4 can move briskly. |
| **Pause** | One full second after *"That is the only manual step in the entire lifecycle."* |
| **Pointer** | On beat 2, physically point at the counters before you speak the numbers. |
| **Scrolling** | On beat 3, scroll at reading speed, not browsing speed. The audience needs to see it is a real document. |
| **Do not say** | "A lot of alerts", "it fixes everything automatically", or "AI decides the fix" — the last is inaccurate, the fix is chosen by deterministic rules. |
| **If asked "what if the AI is wrong?"** | *"The AI writes the explanation. The command itself comes from a fixed rule set. So it can be wrong about why, without ever being able to run the wrong thing."* |

## Where this fits

```
[ 0:00 ]  Positioning and flow diagram   UC-05-RCA-Agent-Narration.md   3:45
[ 3:45 ]  This walkthrough over the video                               2:47
                                                                 TOTAL ≈ 6:32
```

For a hard five minutes, drop the problem section from the positioning script (saves ~43 seconds)
and tighten beat 4 to a single sentence (saves ~15 seconds). That lands at ≈ 5:34; cutting beat 6's
safety-net paragraph as well brings it under five minutes — but that paragraph is the strongest
answer to the hardest question, so cut the positioning script further before you cut it.
