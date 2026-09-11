# UC-10 — recording script

**VM Migration Assurance · VMware to OpenShift Virtualization**

---

## RUNNING ORDER — record in this sequence

| # | Record this | What is on screen | Length |
|---|---|---|---|
| **PART 1** | Opening | **Slide 1** — the title slide | 1m 15s |
| **PART 2** | The workflow | **Slide 2** — "Seven stages for cold, eight for warm" | 2m 15s |
| **PART 3** | The live demo | **The product** — VM Migration Agent in the browser | 6m 30s |
| **PART 4** | Closing | **Slide 3** — the Thank you slide | 40s |

**Total spoken: ≈ 10m 40s. Finished video: 12–13 minutes** once pauses and
transitions are added.

**Record each part as a separate clip.** Clipchamp joins them cleanly, and a
fumbled line then costs you one take instead of the whole video. Part 3 is
itself six clips — see its own running order below.

---

## How to read this script

| In the script | Means |
|---|---|
| **SAY:** followed by indented text | The words you speak. Read them as written. |
| **ON SCREEN:** | What should be visible before you start talking. |
| **DO:** | Where to move the cursor, or what to click, *while* speaking. |
| **[beat]** | Stop for one second. Do not fill it. Silence reads as confidence. |

---

## Before you press record

1. Open the migration agent and turn on **presentation mode** (the **⤢ Present**
   button, top right). Bigger type, prose hidden, fills the frame.
2. Make sure a **completed** migration is already showing in the history panel.
   A recording is not the place to wait for a transfer to finish.
3. Quit Slack and mail. Anything that can pop a notification.
4. Record at **1920×1080**. If your laptop panel is 1366×768, plug in a
   monitor — the small text will not survive video compression otherwise.
5. Open the ServiceNow tab (CHG…) in a second browser tab, ready for Part 3
   step 5.

---
---

# PART 1 — Opening  ·  Slide 1  ·  1m 15s

**ON SCREEN:** The title slide, full screen.
**DO:** Hold two seconds of silence before your first word — it gives you a
clean edit point in Clipchamp.

> **SAY:**
>
> Every organisation moving off VMware right now is asking the same question,
> and it is not *"can we copy the disks?"* **[beat]** The tooling to copy disks
> already exists, and it works. Red Hat ships it — the Migration Toolkit for
> Virtualization.
>
> The question they are actually asking is harder. *Which* machines can move.
> *When.* What breaks if they do. Who signed off. And — three weeks later, when
> somebody asks — what actually happened.
>
> **[beat]**
>
> That is what this is. Not another transfer engine. An **assurance layer**
> around the one Red Hat already gives you.

**DO:** Point the cursor at the quote on the lower half of the slide.

> **SAY:**
>
> And the line at the bottom is the whole design in one sentence. Every
> assessment tool on the market reads the **source** — it inspects vCenter and
> tells you about your VMware estate. This one runs **inside the destination**,
> on the OpenShift cluster the machines are moving to.
>
> Which means it can answer a question none of them can. Not *"will this copy
> cleanly?"* — but **"will this machine actually run when it lands?"**
>
> **[beat]** Those are very different questions, and only one of them matters
> at two in the morning.

**→ Stop recording. That is Part 1.**

---
---

# PART 2 — The workflow  ·  Slide 2  ·  2m 15s

**ON SCREEN:** The slide headed *"Seven stages for cold, eight for warm — they
are different routes"*.

> **SAY:**
>
> Here is the whole thing end to end. Three lanes — and the reason there are
> three is the single most important idea in this design.

**DO:** Run the cursor along the top **BOTH** row, left to right, in time with
the words.

> **SAY:**
>
> The top row is shared. **Discover** is read-only — nothing is ever written to
> vCenter. **Analyse** assesses every machine you discovered, not the ones you
> already picked — and I will come back to why that ordering matters.
> **Select** is where you choose the wave. And **Plan and change** is where the
> estimate, the change window and the CAB approval live.
>
> **[beat]** Now look at what happens next.

**DO:** Cursor on the **COLD** row.

> **SAY:**
>
> A **cold** migration powers the guest off first, and then copies. Which means
> the outage is the *entire transfer*. For a large VM, that is hours.

**DO:** Cursor on the **WARM** row.

> **SAY:**
>
> A **warm** migration copies the disks while the guest carries on serving
> users, and the only downtime is the cutover at the very end. Minutes, not
> hours.

**DO:** Cursor on the greyed-out **"no cutover step"** box in the cold row.

> **SAY:**
>
> And notice this. Cold has **no cutover step at all**. That is why these are
> drawn as two different routes rather than one pipeline with a checkbox —
> because drawn as one pipeline, a cold migration promises you a cutover stage
> it is never going to have. Small thing. It is exactly the sort of small thing
> that loses people's trust in a tool.

**DO:** Cursor along the four coloured chips at the bottom.

> **SAY:**
>
> Four guarantees underneath, and they hold at every stage. Discovery writes
> **nothing** to vCenter. The **AI advises** — warm or cold, with a reason —
> and rules overrule it before you ever see the answer. The **CAB approves**,
> and that gate is re-read from the cluster at the moment you press migrate,
> not trusted from the browser. And the whole thing stays **reversible** until
> the source VMs are deleted — which is a separate change request, days later,
> that a human raises.
>
> **[beat]**

**DO:** Cursor on the green line at the very bottom.

> **SAY:**
>
> Which brings us to the sentence at the bottom. Nothing moves until a plan is
> created, validated, and a change request approved — **and this platform never
> deletes your source VM.** Not at any stage. Not on rollback. Not on success.
>
> Let me show you it running.

**→ Stop recording. That is Part 2.**

---
---

# PART 3 — The live demo  ·  The product  ·  6m 30s

**Record this as six separate clips.** If the cluster is slow, cut the waiting
out between them — but leave the live transfer rate on screen for three or four
seconds somewhere, so it is visibly real rather than a mock-up.

| Step | What you show | Length |
|---|---|---|
| 3.1 | Where you land — readiness and history | 50s |
| 3.2 | Discover | 55s |
| 3.3 | Analyse — the report | 2m 20s |
| 3.4 | Select and plan | 50s |
| 3.5 | The change request | 1m 10s |
| 3.6 | Migrate, cut over, verify | 2m 15s |

---

### 3.1 — Where you land  ·  50s

**ON SCREEN:** Automation Hub → **VM Migration Agent**, presentation mode on,
sitting on step 1.

> **SAY:**
>
> This is the agent. Four steps across the top, and a readiness banner — it has
> already checked that the Migration Toolkit is installed, configured, and that
> this service account can actually read it.

**DO:** Cursor on the **Migration history** panel.

> **SAY:**
>
> And before anything else — **migration history**. Past migrations, what each
> one took against its estimate, the change request it ran under, and what the
> AI cost that run. This survives a rollback deleting the plan, a pod restart,
> and a different person opening this tomorrow — because it is kept in a
> database, not in this browser tab.

---

### 3.2 — Discover  ·  55s

**DO:** Choose the vSphere provider. Click **Discover VMs**.

> **SAY:**
>
> Pick the source, discover. **[beat]** That is a read-only inventory call —
> operating system, addresses, CPU, memory, every disk.

**DO:** Scroll the discovered list slowly.

> **SAY:**
>
> Two details worth calling out. First, there is **no tick box here** — you
> cannot select machines yet, and that is deliberate.
>
> Second, the guest operating system is a real name, not a vSphere code.
> vCenter reports `windows2019srvNext_64Guest` — which means Windows Server
> **2022**, not 2019. `srvNext` means the release *after* the one it names. Get
> that wrong across an estate and half your Windows machines are assessed
> against the wrong support matrix.

---

### 3.3 — Analyse  ·  2m 20s

**DO:** Click through to step 2.

> **SAY:**
>
> Now it assesses **every** machine — and this is that ordering point from the
> slide. You cannot sensibly choose what to migrate until you know what *can*
> be migrated. Pick first, and you are picking blind.

**ON SCREEN:** The report has landed.
**DO:** Cursor on the donut charts.

> **SAY:**
>
> Ready, with caveats, needs review, blocked — grouped by operating system
> family. Underneath each one, the compute and storage it carries, because
> "twelve VMs" and "twelve VMs totalling four terabytes" are different
> problems.

**DO:** Cursor on the **"Will it fit?"** panel.

> **SAY:**
>
> This is the check nobody else makes. On OpenShift Virtualization a VM is a
> **pod** — it has to fit on **one node**. A sixty-four gig guest on thirty-two
> gig workers will copy perfectly, and then sit `Pending` for ever, after you
> have already spent the outage. We only know that because we are running
> *inside* the destination.

**DO:** Cursor on the support-by-distribution bars.

> **SAY:**
>
> Guest support against Red Hat's certified list — and Red Hat publishes
> **three** tiers, not two. Certified, vendor-supported, and known-to-run. The
> difference between them only shows up when you open a support case.

**DO:** Click a VM row to expand it.

> **SAY:**
>
> And per machine, what to change. Snapshots, VMware Tools, virtual TPM,
> pass-through devices. **[beat]** The rule underneath all of this is the one I
> would most want you to remember: **a check that could not run is never
> reported as a pass.** If the inventory did not tell us, it says so. Silence
> never looks like a clean bill of health.

**DO:** Cursor on the **AI usage** cell in the report header.

> **SAY:**
>
> And the AI. Two calls — for the whole fleet. Tokens, and the cost, with the
> arithmetic behind it if you click. The verdicts, the checks, the capacity
> answer and the estimate are all **computed**. The model is asked one thing:
> warm or cold, per machine, and why.

---

### 3.4 — Select and plan  ·  50s

**DO:** Go to step 3. Change one machine's method to show it is editable.

> **SAY:**
>
> Eligible machines are pre-ticked with the method the report recommends — a
> starting point, not a decision. Everything is editable, and warm is only ever
> offered where it can physically work.

**DO:** Go to step 4. Cursor on the estimate panel.

> **SAY:**
>
> Then the estimate — from throughput this cluster has actually achieved, not a
> vendor number. Transfer time and downtime stated **separately**, and costed
> both with and without the VDDK image, so that choice is a number rather than
> a link to a document.

**DO:** Click **Create plan(s)**.

> **SAY:**
>
> Create the plans. **[beat]** MTV validates them — and nothing has moved.

---

### 3.5 — The change request  ·  1m 10s

**DO:** Click **Raise change request**.

> **SAY:**
>
> Now the governance. The platform authors the change request itself: the
> machines, the estimate, the implementation plan, the backout plan, the test
> plan.

**DO:** Cursor on the window dates.

> **SAY:**
>
> And it sizes the **window** properly. That is the implementation window, not
> the outage — pre-checks, the work, verification, **time to back out**, and
> contingency. A window sized to the downtime has no room to put things back if
> it goes wrong, which is how you end up doing unapproved work in the middle of
> an incident.
>
> Both numbers go on the record. A four-hour window, in which the service is
> down for seven minutes. Saying both is what makes it an honest request rather
> than an alarming one.

**DO:** Switch to the ServiceNow tab. Show the attachment on the change record.

> **SAY:**
>
> And the full migration record is **attached** to the ticket. Every VM, how it
> moves, the service impact, how to back out, what the model contributed. A
> description field is a poor place for a table of machines.

---

### 3.6 — Migrate, cut over, verify  ·  2m 15s

**DO:** Back to the console, on a transfer that is running or already finished.

> **SAY:**
>
> Once it is approved, a human clicks migrate — and the server re-reads that
> approval from the cluster before it acts. An enabled button is not
> authorisation.

**DO:** Cursor on the live figures — MB moved, MiB/s, percent.

> **SAY:**
>
> While it runs: megabytes moved of total, the live rate, percent complete. The
> same three numbers MTV's own console shows, in the same units — so you can
> read the two screens side by side without having to reconcile them.

**DO:** Cursor on the cutover panel.

> **SAY:**
>
> Then, on a warm migration, it **stops** — and this is the part people find
> surprising. The copy is finished. The guest is still serving users. Nothing
> more happens until somebody says it may go down, because that is the outage.
>
> So the cutover is gated on the change request, not on a button being present.
> Inside the approved window, you can go now. Before it, you schedule it — and
> MTV performs it with nobody watching. **[beat]** And if the change board moves
> the window, the scheduled cutover follows it.

**DO:** Cursor on the verification panel.

> **SAY:**
>
> Then verification — because *"Succeeded"* on a plan describes the
> **transfer**, not the machine. Is it running. Did it keep its address. Did
> every disk come across. Does it match the shape that was promised.

**DO:** Cursor on the **"Source VM is powered off"** check.

> **SAY:**
>
> And this one. **Is the source VM powered off.** If both are running, you have
> two copies of one identity on one network, each writing to storage the other
> cannot see — and whichever one loses is the one somebody was using. That is
> the failure nobody plans for.
>
> A passing verification closes the change request with the results. A failed
> one closes nothing.

**DO:** Cursor on the decommission panel.

> **SAY:**
>
> And the last step is the only irreversible one — deleting the source. That is
> a **second** change request, after a soak period. And even then this platform
> does not do the deleting. It raises the request; your VMware team carries it
> out.

**→ Stop recording. That is Part 3.**

---
---

# PART 4 — Closing  ·  Slide 3  ·  40s

**ON SCREEN:** The Thank you slide.

> **SAY:**
>
> So — to close where we started. **[beat]**
>
> The copying was never the hard part. What makes a migration programme succeed
> is knowing what can move before you move it, proving it landed properly
> afterwards, and being able to show someone in six months exactly what
> happened and who approved it.
>
> Read-only discovery. Assessed against the target, not just the source. The AI
> where judgement is genuinely needed, and measurement everywhere a fact
> exists. A human on both irreversible acts. And your source VM — still sitting
> there, powered off and intact, until you decide otherwise.
>
> **[beat]** Thank you.

**DO:** Hold two seconds of silence before you stop recording.

**→ That is Part 4. Done.**

---
---

## If you need it shorter

Cut **3.4** and **3.5** down to one sentence each. The plan and the change
request are the least surprising parts of the story, and the workbook covers
them in detail. That takes you to roughly **8 minutes 30 seconds**.

## Three lines worth landing properly

If anything gets rushed, do not let it be these:

1. *"Every other tool reads the source. This one runs inside the destination."*
2. *"A VM is a pod — it has to fit on one node."*
3. *"A check that could not run is never reported as a pass."*

## One thing not to do

**Do not claim a number that is not on the screen.** If the AI cost cell reads
"—" because the provider did not report usage, say so and move on. The product
is built to be honest about exactly that, and a demo that glosses over it
undercuts the thing you are selling.
