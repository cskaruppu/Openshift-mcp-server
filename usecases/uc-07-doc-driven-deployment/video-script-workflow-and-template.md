# TCS Agentic AI — App Deployment Agent (UC-07)
## Video script · Workflow → Template → Recorded demo · exactly 5 minutes

**Purpose:** a customer-facing explainer. It opens on **slide 4 of the UC-07 deck
(Master Workflow)**, explains the fill-in template, then rolls pre-recorded
use-case footage of the Online Boutique deploy. Different from `demo-script.md`
(which is the live product walkthrough) — this one teaches the *model* first,
then proves it with footage.

| | |
|---|---|
| **Runtime** | **5:00 exactly** — 549 spoken words at 135 wpm (4:04 speech) + 56 seconds of deliberate footage-only beats |
| **Assets needed** | Slide 4 of the UC-07 deck · `00-TEMPLATE.docx` open in Word · a screen capture of the placeholder refusal · recorded boutique footage (from `demo-script.md` Take 1+2) |
| **Read** | **SAY** aloud · **SHOW** is on screen · **[SILENT]** rows are footage with no narration — do not fill them |
| **Companion** | Narration blocks at the bottom, ready for TTS or teleprompter |

> The silent beats are not padding — they are where the audience absorbs what
> they just heard. Resist narrating over them; ambient/room tone or light music
> only.

---

## Before you record

| # | Do this | Why |
|---|---|---|
| 1 | Export **slide 4** as a full-screen image (no presenter chrome) | You'll be on it for 1:47 — it must be crisp |
| 2 | Open `00-TEMPLATE.docx` in Word, zoomed so one tier table + its guidance fills the screen | The template beat is 51 seconds; pre-scroll to Application Overview |
| 3 | Capture the **refusal moment** in advance: upload the raw template → screenshot/clip of "17 unfilled placeholder(s): <<app-name>> …" | Doing it live risks a fumble; a 5-second clip is enough |
| 4 | Have the boutique footage cut and ready: (a) GitHub doc scroll, (b) generate + dry-run + deploy clicks, (c) pod watch, (d) pyramid turning green, (e) shop + placing an order | The back half is narration over these five clips in order |
| 5 | Record narration blocks separately (see companion) and lay them on the timeline at the cue points | A fluffed line costs one block, not the take |

---

## Timeline

### 0:00 – 0:24 · Open on the workflow

**SHOW:** Slide 4 — Master Workflow. Full screen, static.

> **SAY:**
> "This is the App Deployment Agent's workflow, end to end, on one slide.
> Before I play the recorded demo, let me walk you through how it works — and
> the template that makes it repeatable for any application.
>
> The colours matter: blue is deterministic automation, purple is AI, amber is
> a person."

---

### 0:24 – 0:55 · Row one — document to reviewed code

**SHOW:** Same slide. Cursor or highlight moves along row 1.

> **SAY:**
> "Row one: from document to reviewed code. A requirement document arrives —
> uploaded, pasted, or pulled straight from Git. If it follows our structured
> template, extraction is deterministic: no AI in the loop, and the same
> document produces the same sixty-four manifests every time. If it is free
> prose, the AI lane architects the manifests instead, under the same security
> contract. Either way a person reviews the generated YAML, and security scans
> run before anything touches a cluster."

---

### 0:55 – 1:19 · Row two — the gate and execution

**SHOW:** Highlight row 2; rest on the amber DEPLOY box.

> **SAY:**
> "Row two: execution. A server-side dry-run validates every object with
> nothing created. Then the one amber box that matters — Deploy. A human
> clicks it; nothing deploys itself. Server-side apply rolls out in dependency
> order, and governance is automatic: a durable record, and a ServiceNow
> change request citing the exact document version."

---

### 1:19 – 1:43 · Row three — the proof

**SHOW:** Highlight row 3, ending on the green "Open application" box.

> **SAY:**
> "Row three is what makes this different. The platform does not stop at
> 'pods are green.' Four verification levels — rollout complete, workloads
> stable, services wired, and finally the platform itself browses to the
> application's URL. Green ends at a button a person can click. Red hands the
> evidence to our RCA agent."

---

### 1:43 – 1:47 · **[SILENT — 4s]** hold on the full slide.

---

### 1:47 – 2:16 · The template

**SHOW:** `00-TEMPLATE.docx` in Word. Scroll slowly: Application Overview →
one tier table with its guidance → the field-reference appendix.

> **SAY:**
> "So how does a customer use this? With this template. Every decision they
> must make is a placeholder in double angle brackets — application name,
> images, ports, storage. Everything else is a working default. Guidance sits
> beside every field, and the appendix maps each entry to exactly what the
> platform will generate from it. A standard three-tier application takes
> about fifteen minutes to fill in."

---

### 2:16 – 2:38 · The template protects itself

**SHOW:** The pre-captured refusal: raw template uploaded → the error listing
`<<app-name>>, <<db-image>> …`

> **SAY:**
> "And the template protects itself. If I upload it unfinished, the agent
> refuses — and lists exactly which placeholders are still empty. A
> half-filled document can never reach a cluster. When you see Google's
> Online Boutique document in a moment, that is this same template — filled in."

---

### 2:38 – 2:53 · Handoff to the footage

**SHOW:** Cut to black for half a second, then the GitHub tab of the boutique doc.

> **SAY:**
> "Now watch it run for real. What follows is recorded from our lab, in
> sequence: the boutique document — twelve tiers, eleven microservices, one
> Redis cart — and one deploy."

---

### 2:53 – 3:00 · **[SILENT — 7s]** footage: the boutique document scrolling on GitHub — tier tables, the network matrix.

---

### 3:00 – 3:24 · Footage: generate → dry-run → deploy

**SHOW:** Clips (b): Load from Git fills the textarea → Generate ("12 tiers →
64 manifests") → Dry-run all green → Deploy with created-chips + CR number.

> **SAY:**
> "From the GitHub link: generate. Sixty-four manifests in about a second —
> deterministic. The dry-run validates all of them through full admission.
> Deploy: every object reports created, configured or unchanged, and the
> change record is already in ServiceNow before the first pod starts."

---

### 3:24 – 3:40 · **[SILENT — 16s]** footage: the live pod watch streaming, twelve services going Ready. Let it breathe.

---

### 3:40 – 4:11 · Footage: the pyramid and the shop

**SHOW:** Clips (d)+(e): four verification cards turning green → Open
application → the storefront → add to cart → Place Order → confirmation.

> **SAY:**
> "The pyramid runs itself: rollout, stability, wiring — and the platform
> browses to the store from outside. One click, and this is a working shop,
> with synthetic customers already browsing. I place an order: that single
> click crosses nine microservices and a Redis cart, and every hop crosses a
> network policy the document declared."

---

### 4:11 – 4:30 · **[SILENT — 19s]** footage: hold on the order confirmation, then cut back to the four green verification cards. This is the shot that sells it.

---

### 4:30 – 4:48 · Close

**SHOW:** Slide 4 again, or the deck's closing slide.

> **SAY:**
> "Fill the template. Review, deploy, click the URL — those are the only
> human steps. The requirement document is the deployment — and verification
> is never generated. That is the App Deployment Agent."

---

### 4:48 – 5:00 · **[END CARD — 12s]** product name, use case ID, contact. Music out.

---

# Narration blocks — for TTS / teleprompter

549 words / 4:04 spoken. Render each block separately; place at its cue.
Blank lines are deliberate pauses — do not close them up.

```
BLOCK 1  CUE 0:00  (53 words)
This is the App Deployment Agent's workflow, end to end, on one slide. Before I play the recorded demo, let me walk you through how it works - and the template that makes it repeatable for any application.

The colours matter: blue is deterministic automation, purple is AI, amber is a person.

BLOCK 2  CUE 0:24  (74 words)
Row one: from document to reviewed code. A requirement document arrives - uploaded, pasted, or pulled straight from Git. If it follows our structured template, extraction is deterministic: no AI in the loop, and the same document produces the same sixty-four manifests every time. If it is free prose, the AI lane architects the manifests instead, under the same security contract. Either way a person reviews the generated YAML, and security scans run before anything touches a cluster.

BLOCK 3  CUE 0:55  (54 words)
Row two: execution. A server-side dry-run validates every object with nothing created. Then the one amber box that matters - Deploy. A human clicks it; nothing deploys itself. Server-side apply rolls out in dependency order, and governance is automatic: a durable record, and a ServiceNow change request citing the exact document version.

BLOCK 4  CUE 1:19  (54 words)
Row three is what makes this different. The platform does not stop at pods are green. Four verification levels - rollout complete, workloads stable, services wired, and finally the platform itself browses to the application's URL. Green ends at a button a person can click. Red hands the evidence to our RCA agent.

BLOCK 5  CUE 1:47  (66 words)
So how does a customer use this? With this template. Every decision they must make is a placeholder in double angle brackets - application name, images, ports, storage. Everything else is a working default. Guidance sits beside every field, and the appendix maps each entry to exactly what the platform will generate from it. A standard three-tier application takes about fifteen minutes to fill in.

BLOCK 6  CUE 2:16  (49 words)
And the template protects itself. If I upload it unfinished, the agent refuses - and lists exactly which placeholders are still empty. A half-filled document can never reach a cluster. When you see Google's Online Boutique document in a moment, that is this same template - filled in.

BLOCK 7  CUE 2:38  (33 words)
Now watch it run for real. What follows is recorded from our lab, in sequence: the boutique document - twelve tiers, eleven microservices, one Redis cart - and one deploy.

BLOCK 8  CUE 3:00  (52 words)
From the GitHub link: generate. Sixty-four manifests in about a second - deterministic. The dry-run validates all of them through full admission. Deploy: every object reports created, configured or unchanged, and the change record is already in ServiceNow before the first pod starts.

BLOCK 9  CUE 3:40  (60 words)
The pyramid runs itself: rollout, stability, wiring - and the platform browses to the store from outside. One click, and this is a working shop, with synthetic customers already browsing. I place an order: that single click crosses nine microservices and a Redis cart, and every hop crosses a network policy the document declared.

BLOCK 10  CUE 4:30  (40 words)
Fill the template. Review, deploy, click the URL - those are the only human steps. The requirement document is the deployment - and verification is never generated. That is the App Deployment Agent.
```
