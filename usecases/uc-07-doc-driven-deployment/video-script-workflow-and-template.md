# TCS Agentic AI — App Deployment Agent (UC-07)
## Video script · 3 slides + recorded demo · 5 minutes

**Purpose:** the customer-facing explainer. Three slides teach the use case, the
workflow and the template — then recorded footage proves it by deploying a real
e-commerce application from one document.

| | |
|---|---|
| **Structure** | Slide 1 introduction (0:00) → Slide 2 end-to-end workflow (0:35) → Slide 3 the template (2:12) → recorded demo (3:15) → close (4:52) |
| **Runtime** | ~5:00 — spoken narration at 135 wpm plus deliberate footage-only beats |
| **Slides** | Slide 2 = **slide 4 of the UC-07 deck** (Master Workflow), exported full-screen. Slides 1 and 3 are built from the content below |
| **Read** | **SAY** aloud · **SHOW** is what is on screen · **[SILENT]** = footage with no narration, do not fill it |
| **Companion** | Narration blocks at the bottom — TTS or teleprompter ready |

> The silent beats are where the audience absorbs what they just heard. Ambient
> room tone or light music only — resist narrating over them.

---

## Before you record

| # | Do this | Why |
|---|---|---|
| 1 | Build **slide 1** (title + the four stat tiles: 64 manifests · 0 YAML by hand · 4 verification levels · 3 human touches) and **slide 3** (the template — a screenshot of one filled tier table beside the placeholder list). Export **slide 4 of the UC-07 deck** as slide 2 | You are on slides for the first 3:15 — they must be crisp, no presenter chrome |
| 2 | Open `00-TEMPLATE.docx` in Word, pre-scrolled to Application Overview | Slide 3 cuts to the live document for 25 seconds |
| 3 | Pre-capture the **refusal clip**: upload the unfilled template → the error listing `<<app-name>>, <<db-image>> …` | 5 seconds of footage; doing it live risks a fumble |
| 4 | Cut the demo footage into **six clips**: (a) the FILLED `04-ecommerce-online-boutique.docx` in Word, (b) **Upload requirement doc** → pick the file → Generate, (c) the **Deploy to cluster** dropdown + **Dry-run** result, (d) **Deploy** → created-chips + change number, (e) the live pod watch, (f) the four verification cards + storefront + placing an order | Clip (a) must be the *filled* document — the audience must recognise the same tables from slide 3 carrying real values |
| 5 | **Warm the images first:** run the whole flow ~30 min before recording, then roll back. Re-record clip (e) with images cached | Otherwise the pod watch is five minutes of dead air instead of ninety seconds |
| 6 | Record narration blocks separately and lay them at the cue points | A fluffed line costs one block, not the take |

---

# SLIDE 1 · Introduction

### 0:00 – 0:35

**SHOW:** Slide 1 — *App Deployment Agent · Use Case 07*, with the four stat tiles.

> **SAY:**
> "This is the App Deployment Agent — use case zero seven in the TCS Agentic AI
> portfolio for hybrid infrastructure.
>
> Today, turning a requirement into a running application takes days. Someone
> writes two thousand lines of YAML by hand, gets it reviewed, and deploys it.
> And when the pods turn green, nobody has proven the application actually works.
>
> This agent deploys the requirement document itself — and proves it works, to a
> URL you can click."

---

# SLIDE 2 · End-to-end workflow

### 0:35 – 1:00 · The model

**SHOW:** Slide 2 (deck slide 4) — Master Workflow. Full screen, static.

> **SAY:**
> "Here is the whole workflow on one slide, and the colours carry the meaning.
> Blue is deterministic automation — no AI in the loop. Purple is where AI is
> applied. Amber is where a person is required. There are only three amber
> boxes in the entire flow."

---

### 1:00 – 1:25 · Row one — document to reviewed code

**SHOW:** Same slide, highlight moving along row 1.

> **SAY:**
> "Row one. A requirement document arrives — uploaded, or pulled from Git. If it
> follows our template, extraction is deterministic: the same document produces
> the same manifests every time. Free prose instead? The AI lane architects them
> under the same security contract. Then a person reviews the generated code."

---

### 1:25 – 1:47 · Row two — the gate

**SHOW:** Highlight row 2; rest on the amber DEPLOY box.

> **SAY:**
> "Row two: execution. Security scans run on the generated code, then a
> server-side dry-run validates every object while creating nothing. Then the
> amber box that matters — Deploy. A person clicks it. Nothing here ever
> deploys itself."

---

### 1:47 – 2:07 · Row three — the proof

**SHOW:** Highlight row 3, ending on the green *Open application* box.

> **SAY:**
> "Row three is the difference. We do not stop at 'pods are green.' Four
> verification levels — rollout complete, workloads stable, services wired,
> and the platform itself browsing to the application's URL. Green ends at a
> button. Red hands the evidence to our RCA agent."

---

### 2:07 – 2:12 · **[SILENT — 5s]** hold on the full slide.

---

# SLIDE 3 · The template

### 2:12 – 2:50 · What the customer fills in

**SHOW:** Slide 3 for a beat, then cut to `00-TEMPLATE.docx` in Word: scroll
Application Overview → one tier table with its guidance → the field reference.

> **SAY:**
> "So what does a customer actually do? They fill in this template.
>
> Every decision is a placeholder in double angle brackets — application name,
> namespace, images, ports, storage. Everything else is a working default.
> Guidance sits beside every field, and the appendix maps each entry to exactly
> what the platform generates from it — a Route, a volume, an autoscaler, a
> network policy.
>
> A three-tier application takes about fifteen minutes. Word or Markdown,
> whichever the customer prefers."

---

### 2:50 – 3:05 · The template protects itself

**SHOW:** The pre-captured refusal clip.

> **SAY:**
> "And it protects itself. Upload it unfinished and the agent refuses, listing
> exactly which placeholders are still empty. A half-filled document can never
> reach a cluster."

---

### 3:05 – 3:15 · Handoff to the demo

**SHOW:** Cut to clip (a) — the filled boutique document in Word.

> **SAY:**
> "Here is that same template, filled in: Google's Online Boutique — a real
> e-commerce shop, eleven microservices and a Redis cart, twelve tiers. Now
> watch it deploy."

---

# RECORDED DEMO

### 3:15 – 3:22 · **[SILENT — 7s]** clip (a): scroll the filled document — a tier table, then the network connectivity matrix.

---

### 3:22 – 3:45 · Upload the document, choose the cluster

**SHOW:** Clip (b) → (c): **Upload requirement doc** → pick the boutique file →
the text fills → **Generate Manifests** → then the **Deploy to cluster**
dropdown, selecting the target cluster.

> **SAY:**
> "Upload the document — Word, PDF or Markdown, all supported. Or paste a
> GitHub link and the platform pulls it straight from version control.
>
> Generate: twelve tiers become sixty-four manifests in about a second. Then
> choose the target cluster — any OpenShift cluster connected to the platform."

---

### 3:45 – 4:05 · Dry-run and verify before deploying

**SHOW:** Clip (c): **Dry-run** → the result renders, every object validated.

> **SAY:**
> "Dry-run first. The API server validates all sixty-four objects through full
> admission — schemas, quotas, policies — and creates nothing. This is where
> you confirm the deployment is sound before anything is committed to the
> cluster."

---

### 4:05 – 4:25 · Deploy

**SHOW:** Clip (d): **Deploy** → created-chips → the record id and change number.

> **SAY:**
> "Verified — now deploy. Server-side apply, in dependency order. Every object
> reports created, configured or unchanged. And a ServiceNow change request is
> raised automatically, citing the exact document version that produced it."

---

### 4:25 – 4:37 · **[SILENT — 12s]** clip (e): the live pod watch, twelve services going Ready.

---

### 4:37 – 4:52 · Verified, and open

**SHOW:** Clip (f): four verification cards turning green → **Open application**
→ the storefront → placing an order → confirmation.

> **SAY:**
> "The four verification levels run by themselves, ending with the platform
> browsing the store from outside. One click — a working shop. This order
> crosses nine microservices and the Redis cart."

---

### 4:52 – 5:00 · Close

**SHOW:** Hold on the order confirmation, then the closing slide.

> **SAY:**
> "Fill the template. Review, deploy, click the URL. Those are the only human
> steps."

---

# Narration blocks — for TTS / teleprompter

Render each block separately and place it at its cue. Blank lines are
deliberate pauses — do not close them up.

```
BLOCK 1  CUE 0:00  SLIDE 1 - introduction
This is the App Deployment Agent - use case zero seven in the TCS Agentic AI portfolio for hybrid infrastructure.

Today, turning a requirement into a running application takes days. Someone writes two thousand lines of YAML by hand, gets it reviewed, and deploys it. And when the pods turn green, nobody has proven the application actually works.

This agent deploys the requirement document itself - and proves it works, to a URL you can click.

BLOCK 2  CUE 0:35  SLIDE 2 - the model
Here is the whole workflow on one slide, and the colours carry the meaning. Blue is deterministic automation - no AI in the loop. Purple is where AI is applied. Amber is where a person is required. There are only three amber boxes in the entire flow.

BLOCK 3  CUE 1:00  SLIDE 2 - row one
Row one. A requirement document arrives - uploaded, or pulled from Git. If it follows our template, extraction is deterministic: the same document produces the same manifests every time. Free prose instead? The AI lane architects them under the same security contract. Then a person reviews the generated code.

BLOCK 4  CUE 1:25  SLIDE 2 - row two
Row two: execution. Security scans run on the generated code, then a server-side dry-run validates every object while creating nothing. Then the amber box that matters - Deploy. A person clicks it. Nothing here ever deploys itself.

BLOCK 5  CUE 1:47  SLIDE 2 - row three
Row three is the difference. We do not stop at pods are green. Four verification levels - rollout complete, workloads stable, services wired, and the platform itself browsing to the application's URL. Green ends at a button. Red hands the evidence to our RCA agent.

BLOCK 6  CUE 2:12  SLIDE 3 - the template
So what does a customer actually do? They fill in this template.

Every decision is a placeholder in double angle brackets - application name, namespace, images, ports, storage. Everything else is a working default. Guidance sits beside every field, and the appendix maps each entry to exactly what the platform generates from it - a Route, a volume, an autoscaler, a network policy.

A three-tier application takes about fifteen minutes. Word or Markdown, whichever the customer prefers.

BLOCK 7  CUE 2:50  SLIDE 3 - the guard
And it protects itself. Upload it unfinished and the agent refuses, listing exactly which placeholders are still empty. A half-filled document can never reach a cluster.

BLOCK 8  CUE 3:05  handoff
Here is that same template, filled in: Google's Online Boutique - a real e-commerce shop, eleven microservices and a Redis cart, twelve tiers. Now watch it deploy.

BLOCK 9  CUE 3:22  DEMO - upload and cluster
Upload the document - Word, PDF or Markdown, all supported. Or paste a GitHub link and the platform pulls it straight from version control.

Generate: twelve tiers become sixty-four manifests in about a second. Then choose the target cluster - any OpenShift cluster connected to the platform.

BLOCK 10  CUE 3:45  DEMO - dry-run
Dry-run first. The API server validates all sixty-four objects through full admission - schemas, quotas, policies - and creates nothing. This is where you confirm the deployment is sound before anything is committed to the cluster.

BLOCK 11  CUE 4:05  DEMO - deploy
Verified - now deploy. Server-side apply, in dependency order. Every object reports created, configured or unchanged. And a ServiceNow change request is raised automatically, citing the exact document version that produced it.

BLOCK 12  CUE 4:37  DEMO - verified and open
The four verification levels run by themselves, ending with the platform browsing the store from outside. One click - a working shop. This order crosses nine microservices and the Redis cart.

BLOCK 13  CUE 4:52  close
Fill the template. Review, deploy, click the URL. Those are the only human steps.
```
