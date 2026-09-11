# UC-10 — recording script

**VM Migration Assurance · VMware to OpenShift Virtualization**

Written to be read aloud over a screen recording. Roughly **10 minutes 40 seconds** of narration at a normal 150 words
per minute — measured from the script, not estimated — across four segments, each recorded separately so a fluffed line
costs one take rather than the whole video.

**How to use it.** Everything in `>` blockquotes is what you say. Everything in
*[square brackets]* is a stage direction — what should be on screen, or what to
click — and is never spoken. Pauses are marked **[beat]**: a full second of
silence, which sounds like confidence on playback and costs nothing to add in
Clipchamp.

**Before you start**
- Open the migration agent in **presentation mode** (⤢ Present) — larger type,
  explanatory prose hidden, fits the frame on a shared screen.
- Have a **completed** migration already in the history panel. A recording is
  not the place to wait for a transfer.
- Close Slack, mail, and anything that can raise a notification.
- Record at **1920×1080**. If your laptop is 1366×768, plug in a monitor —
  the small text will not survive compression otherwise.

---

## Segment 1 · Title slide  ·  1m 15s

*[Full-screen title slide. Hold it for two seconds of silence before you speak
— Clipchamp gives you a clean handle to trim against.]*

> Every organisation moving off VMware right now is asking the same question,
> and it is not *"can we copy the disks?"* **[beat]** The tooling to copy disks
> already exists, and it works. Red Hat ships it — the Migration Toolkit for
> Virtualization.

> The question they are actually asking is harder. *Which* machines can move.
> *When*. What breaks if they do. Who signed off. And — three weeks later, when
> somebody asks — what actually happened.

> **[beat]**

> That is what this is. Not another transfer engine. An **assurance layer**
> around the one Red Hat already gives you.

*[Point the cursor at the quote on the lower half of the slide.]*

> And the line at the bottom is the whole design in one sentence. Every
> assessment tool on the market reads the **source** — it inspects vCenter and
> tells you about your VMware estate. This one runs **inside the destination**,
> on the OpenShift cluster the machines are moving to.

> Which means it can answer a question none of them can. Not *"will this copy
> cleanly?"* — but **"will this machine actually run when it lands?"**

> **[beat]** Those are very different questions, and only one of them matters at
> two in the morning.

---

## Segment 2 · The workflow slide  ·  2m 15s

*[Switch to the "Seven stages for cold, eight for warm" slide.]*

> Here is the whole thing end to end. Three lanes — and the reason there are
> three is the single most important idea in this design.

*[Cursor along the top BOTH row, left to right, in time with the words.]*

> The top row is shared. **Discover** is read-only — nothing is ever written to
> vCenter. **Analyse** assesses every machine you discovered, not the ones you
> already picked, and I will come back to why that ordering matters. **Select**
> is where you choose the wave. And **Plan and change** is where the estimate,
> the change window and the CAB approval live.

> **[beat]** Now look at what happens next.

*[Cursor on the COLD row.]*

> A **cold** migration powers the guest off first, and then copies. Which means
> the outage is the *entire transfer*. For a large VM that is hours.

*[Cursor on the WARM row.]*

> A **warm** migration copies the disks while the guest carries on serving
> users, and the only downtime is the cutover at the very end. Minutes, not
> hours.

*[Cursor on the greyed "no cutover step" box in the cold row.]*

> And notice this. Cold has **no cutover step at all**. That is why these are
> drawn as two different routes rather than one pipeline with a checkbox —
> because drawn as one pipeline, a cold migration promises you a cutover stage
> it is never going to have. Small thing. It is the sort of small thing that
> loses people's trust in a tool.

*[Cursor along the four coloured chips at the bottom.]*

> Four guarantees underneath, and they hold at every stage. Discovery writes
> **nothing** to vCenter. The **AI advises** — warm or cold, with a reason —
> and rules overrule it before you ever see the answer. The **CAB approves**,
> and that gate is re-read from the cluster at the moment you press migrate,
> not trusted from the browser. And the whole thing stays **reversible** until
> the source VMs are deleted — which is a separate change request, days later,
> that a human raises.

> **[beat]**

*[Cursor on the green line at the very bottom.]*

> Which brings us to the sentence at the bottom. Nothing moves until a plan is
> created, validated, and a change request approved — **and this platform never
> deletes your source VM.** Not at any stage. Not on rollback. Not on success.

> Let me show you it running.

---

## Segment 3 · The live walkthrough  ·  6m 30s

*[Screen share the console. Automation Hub → VM Migration Agent, presentation
mode on, step 1.]*

### 3a · Where you land  ·  50s

> This is the agent. Four steps across the top, and the readiness banner —
> it has checked that the Migration Toolkit is installed, configured, and that
> this service account can actually read it.

*[Cursor on the Migration history panel.]*

> And before anything else: **migration history**. Past migrations, what each
> one took against its estimate, the change request, and what the AI cost that
> run. This survives a rollback deleting the plan, a pod restart, and a
> different person opening this tomorrow — because it is kept in a database,
> not in this browser tab.

### 3b · Discover  ·  55s

*[Choose the vSphere provider. Click Discover VMs.]*

> Pick the source, discover. **[beat]** That is a read-only inventory call —
> operating system, addresses, CPU, memory, every disk.

*[Scroll the discovered list.]*

> Two details worth calling out. There is **no tick box here** — you cannot
> select machines yet, deliberately. And the guest operating system is a real
> name, not a vSphere code. vCenter reports `windows2019srvNext_64Guest`, which
> means Windows Server **2022**, not 2019 — `srvNext` means the release *after*
> the one it names. Get that wrong across an estate and half your Windows
> machines are assessed against the wrong support matrix.

### 3c · Analyse  ·  2m 20s

*[Click through to step 2. Let the progress panel show if the assessment runs.]*

> Now it assesses **every** machine — and this is that ordering point from the
> slide. You cannot sensibly choose what to migrate until you know what *can*
> be migrated. Pick first and you are picking blind.

*[The report lands. Cursor on the donuts.]*

> Ready, with caveats, needs review, blocked — by operating system family.
> Underneath each one, the compute and storage it carries, because "twelve VMs"
> and "twelve VMs totalling four terabytes" are different problems.

*[Cursor on "Will it fit?".]*

> This is the check nobody else makes. On OpenShift Virtualization a VM is a
> **pod** — it has to fit on **one node**. A sixty-four gig guest on thirty-two
> gig workers will copy perfectly, and then sit `Pending` for ever, after you
> have spent the outage. We only know that because we are running *inside* the
> destination.

*[Cursor on the support-by-distribution bars.]*

> Guest support against Red Hat's certified list — and Red Hat publishes
> **three** tiers, not two. Certified, vendor-supported, and known-to-run. The
> difference only shows up when you open a support case.

*[Expand one VM row.]*

> And per machine, what to change. Snapshots, VMware Tools, vTPM, pass-through
> devices. **[beat]** The rule underneath all of this is the one I would most
> want you to remember: **a check that could not run is never reported as a
> pass.** If the inventory did not tell us, it says so. Silence never looks
> like a clean bill of health.

*[Cursor on the AI usage cell in the header.]*

> And the AI. Two calls — for the whole fleet. Tokens, and the cost, with the
> arithmetic behind it if you click. The verdicts, the checks, the capacity
> answer and the estimate are all **computed**. The model is asked one thing:
> warm or cold, per machine, and why.

### 3d · Select and plan  ·  50s

*[Step 3. Machines pre-ticked; change one method.]*

> Eligible machines are pre-ticked with the method the report recommends — a
> starting point, not a decision. Everything is editable, and warm is only
> offered where it can physically work.

*[Step 4. The estimate panel.]*

> Then the estimate, from throughput this cluster has actually achieved, not a
> vendor number. Transfer time and downtime stated **separately** — and costed
> both with and without the VDDK image, so that choice is a number rather than
> a link to a document.

*[Click Create plan(s).]*

> Create the plans. **[beat]** MTV validates them — and nothing has moved.

### 3e · The change request  ·  1m 10s

*[Click Raise change request.]*

> Now the governance. The platform authors the change request: the machines,
> the estimate, the implementation plan, the backout plan, the test plan.

*[Cursor on the window.]*

> And it sizes the **window** properly. That is the implementation window, not
> the outage — pre-checks, the work, verification, **time to back out**, and
> contingency. A window sized to the downtime has no room to put things back if
> it goes wrong, which is how you end up doing unapproved work in the middle of
> an incident.

> Both numbers go on the record. A four-hour window, in which the service is
> down for seven minutes. Saying both is what makes it an honest request rather
> than an alarming one.

*[Switch to the ServiceNow tab, show the attachment.]*

> And the full migration record is **attached** to the ticket. Every VM, how it
> moves, the impact, how to back out, what the model contributed. A description
> field is a poor place for a table of machines.

### 3f · Migrate, cut over, verify  ·  2m 15s

*[Back to the console, showing an in-flight or completed transfer.]*

> Once it is approved, a human clicks migrate — and the server re-reads that
> approval from the cluster before it acts. An enabled button is not
> authorisation.

*[Cursor on the live figures.]*

> While it runs: megabytes moved of total, the live rate, percent. The same
> three numbers MTV's own console shows, in the same units, so you can read the
> two screens side by side without reconciling them.

*[Cursor on the cutover panel.]*

> Then, on a warm migration, it **stops** — and this is the part people find
> surprising. The copy is finished. The guest is still serving users. Nothing
> more happens until somebody says it may go down, because that is the outage.

> So the cutover is gated on the change request, not on a button being present.
> Inside the approved window you can go now. Before it, you schedule it, and
> MTV performs it with nobody watching. **[beat]** And if the change board moves
> the window, the scheduled cutover follows it.

*[Cursor on the verification panel.]*

> Then verification — because *"Succeeded"* on a plan describes the **transfer**,
> not the machine. Is it running. Did it keep its address. Did every disk come
> across. Does it match the shape that was promised.

*[Cursor on the source-off check.]*

> And this one. **Is the source VM powered off.** If both are running you have
> two copies of one identity on one network, each writing to storage the other
> cannot see — and whichever one loses is the one somebody was using. That is
> the failure nobody plans for.

> A passing verification closes the change request with the results. A failed
> one closes nothing.

*[Cursor on the decommission panel.]*

> And the last step is the only irreversible one: deleting the source. That is
> a **second** change request, after a soak period, and this platform still does
> not do the deleting — it raises the request, and your VMware team carries it
> out.

---

## Segment 4 · Thank you  ·  40s

*[Thank-you slide.]*

> So — to close where we started. **[beat]**

> The copying was never the hard part. What makes a migration programme succeed
> is knowing what can move before you move it, proving it landed properly
> afterwards, and being able to show someone in six months exactly what
> happened and who approved it.

> Read-only discovery. Assessed against the target, not just the source. The
> AI where judgement is genuinely needed and measurement everywhere a fact
> exists. A human on both irreversible acts. And your source VM, still sitting
> there, powered off and intact, until you decide otherwise.

> **[beat]** Thank you.

*[Hold two seconds of silence before you stop recording.]*

---

## Recording notes

**Timings** — counted from the spoken lines rather than estimated:
1m 15s + 2m 15s + 6m 30s + 40s ≈ **10m 40s** of narration at 150 words a
minute. Allow **12–13 minutes finished**, once the beats and the screen
transitions are in. If you need it under ten, cut 3d and 3e to a sentence each
— the plan and the change request are the least surprising parts, and the
workbook covers them.

**Record the four segments separately.** Clipchamp joins them cleanly, and a
fluffed line costs one take rather than the whole video.

**If the demo cluster is slow**, record segment 3 in pieces and cut the waiting
out. Nobody needs to watch a progress bar — but do leave the live rate on
screen for three or four seconds so it is visibly real rather than a mock-up.

**The three lines worth landing properly**, if you are tight on time and have
to cut something else:
1. *"Every other tool reads the source. This one runs inside the destination."*
2. *"A VM is a pod — it has to fit on one node."*
3. *"A check that could not run is never reported as a pass."*

**Do not claim** a number you cannot show on screen. If the AI cost cell reads
"—" because the provider did not report usage, say so and move on — the tool is
built to be honest about that, and a demo that glosses over it undercuts the
thing you are selling.
